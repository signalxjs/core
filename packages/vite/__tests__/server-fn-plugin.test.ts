/**
 * @vitest-environment node
 *
 * sigxServer() (rfc-server §3, #305): environment-split transform (client →
 * stubs, SSR → body + `__sigxKey` stamps), the virtual registry module,
 * extraction warnings, and the dev lint for unextracted serverFn.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxServer } from '../src/server-fn';

const CART = `
import { serverFn } from '@sigx/server';
import { db } from './db';

export const addToCart = serverFn(async (rq, id: string) => db.cart.add(id));
export const auditLog = (line: string) => { console.log(line); };
`;

function makeProject(
    files: Record<string, string>,
    command: 'build' | 'serve' = 'build',
    options?: Parameters<typeof sigxServer>[0]
): { plugin: any; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'sigx-server-fn-'));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
    // These tests are about EXTRACTION mechanics — keys, stubs, registry
    // keys — so the guard gate (#489, default ON) is opt-in here rather than
    // noise on every fixture. Its own behaviour is covered below.
    const plugin = sigxServer({ requireAuthorization: false, ...options }) as any;
    plugin.configResolved({ root, command });
    return { plugin, root };
}

describe('sigxServer — transform', () => {
    let plugin: any;
    let root: string;

    beforeAll(() => {
        ({ plugin, root } = makeProject({ 'src/cart.server.ts': CART }));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('replaces the module with stubs in the client environment', () => {
        const result = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            CART,
            join(root, 'src/cart.server.ts')
        );
        expect(result.code).toContain(`from '@sigx/server/client'`);
        expect(result.code).toMatch(
            /__serverFnStub\("src\/cart\.server\.ts\/addToCart", "addToCart", "\/_sigx\/fn", "[0-9a-f]{8}"\)/
        );
        expect(result.code).toContain('__serverOnly("auditLog"');
        expect(result.code).not.toContain('db.cart.add');
    });

    it('keeps the module body in the SSR environment, appending __sigxKey stamps (#452)', () => {
        const result = plugin.transform.call(
            { environment: { name: 'ssr' }, warn: () => {} },
            CART,
            join(root, 'src/cart.server.ts')
        );
        // Body kept verbatim; the wrapper gains the stub's stable key.
        expect(result.code.startsWith(CART)).toBe(true);
        expect(result.code).toContain('addToCart.__sigxKey = "src/cart.server.ts/addToCart";');
        // Re-running over stamped output must not double-stamp.
        const again = plugin.transform.call(
            { environment: { name: 'ssr' }, warn: () => {} },
            result.code,
            join(root, 'src/cart.server.ts')
        );
        expect(again).toBeNull();
    });

    it('surfaces extraction warnings through this.warn', () => {
        const warnings: string[] = [];
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import { serverFn } from '@sigx/server';\nexport * from './more';`,
            join(root, 'src/other.server.ts')
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('export *');
    });

    it('never serves the real module on a failed extraction', () => {
        const file = join(root, 'src/cart.server.ts');
        // A good pass first (cache), then a mid-edit syntax error.
        plugin.transform.call({ environment: { name: 'client' }, warn: () => {} }, CART, file);
        const broken = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            CART + '\nconst oops = {',
            file
        );
        expect(broken.code).toContain('__serverFnStub'); // last good stub
        expect(broken.code).not.toContain('db.cart.add');

        // No cache at all → a loud refusal, still not the server body.
        const fresh = join(root, 'src/never-seen.server.ts');
        const refused = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            'const broken = {',
            fresh
        );
        expect(refused.code).toContain('refusing to serve');
        expect(refused.code).toMatch(/^throw new Error/);
    });

    it('ignores non-matching files', () => {
        expect(
            plugin.transform.call(
                { environment: { name: 'client' }, warn: () => {} },
                'export const x = 1;',
                join(root, 'src/Page.tsx')
            )
        ).toBeNull();
    });
});

describe('sigxServer — path-separator normalization (#324)', () => {
    it('discovery + transform register one entry per file across separators', () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const posixId = join(root, 'src/cart.server.ts').replace(/\\/g, '/');
            plugin.transform.call(
                { environment: { name: 'client' }, warn: () => {} },
                CART,
                posixId
            );
            const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
            // One record — an unnormalized second map entry would emit the
            // same key twice.
            expect(registry.match(/\["src\/cart\.server\.ts\/addToCart"\]:/g)).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxServer — virtual registry', () => {
    let plugin: any;
    let root: string;

    beforeAll(() => {
        ({ plugin, root } = makeProject({ 'src/cart.server.ts': CART }));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('resolves and loads key → { version, load } records', () => {
        const resolved = plugin.resolveId('virtual:sigx-server-fns');
        expect(resolved).toBe('\0virtual:sigx-server-fns');
        const code = plugin.load(resolved);
        expect(code).toContain('export const serverFns = {');
        expect(code).toMatch(
            /\["src\/cart\.server\.ts\/addToCart"\]: \{ version: "[0-9a-f]{8}", load: \(\) => import\("\/src\/cart\.server\.ts"\)\.then\(m => m\["addToCart"\]\) \},/
        );
        // Only serverFn exports register — server-only values have no key.
        expect(code).not.toContain('auditLog');
    });

    it('exports the mount path the build baked, beside the registry (#563)', () => {
        // The one place an app's entry can READ the base: `base` lived only
        // in the plugin config, so `matchesServerFn(request)` and the handler
        // each fell back to the default and a moved mount routed nothing.
        expect(plugin.load(plugin.resolveId('virtual:sigx-server-fns'))).toContain(
            'export const serverFnBase = "/_sigx/fn";'
        );
    });

    it('serverFnBase follows a custom base', () => {
        const { plugin: moved, root: movedRoot } = makeProject(
            { 'src/cart.server.ts': CART },
            'build',
            { base: '/rpc' }
        );
        try {
            expect(moved.load(moved.resolveId('virtual:sigx-server-fns'))).toContain(
                'export const serverFnBase = "/rpc";'
            );
        } finally {
            rmSync(movedRoot, { recursive: true, force: true });
        }
    });

    it('emits a null-prototype registry — prototype-named keys miss cleanly (#555)', () => {
        const code = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
        // The literal `__proto__: null` must LEAD the object so every
        // registry lookup (`functions[key]`) has no inherited chain.
        expect(code).toContain('__proto__: null,');
        // Behavior pin: evaluate the emitted module text. The lazy `import()`
        // records are parse-legal inside Function and never invoked.
        // replaceAll, not replace: the module has carried a second export
        // since #563 (`serverFnBase`), and a leftover `export` is a SyntaxError.
        const fns = new Function(`${code.replaceAll('export const', 'const')}; return serverFns;`)() as Record<string, unknown>;
        expect(Object.getPrototypeOf(fns)).toBe(null);
        expect(fns['constructor']).toBeUndefined();
        expect(fns['hasOwnProperty']).toBeUndefined();
    });
});

describe('sigxServer — non-callable server-only exports (#565)', () => {
    const VALUES = `
import { serverFn } from '@sigx/server';
export const MAX = 10;
export class Db {}
export const helper = makeThing();
export const addToCart = serverFn(async (rq, id) => id);
`;

    /** Transform the server module in one environment, collecting warnings. */
    function warnFor(env: 'client' | 'ssr'): string[] {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': VALUES });
        try {
            const warnings: string[] = [];
            plugin.transform.call(
                { environment: { name: env }, warn: (m: string) => warnings.push(m) },
                VALUES,
                join(root, 'src/cart.server.ts')
            );
            return warnings;
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }

    it('warns once per non-callable export that reaches the client bundle', () => {
        const warnings = warnFor('client');
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('"MAX"');
        expect(warnings[0]).toContain('a non-call use is SILENT and wrong');
        expect(warnings[1]).toContain('"Db"');
        expect(warnings[1]).toContain('is not a constructor');
        // `helper` might be callable — never warned about.
        expect(warnings.join('\n')).not.toContain('"helper"');
    });

    it('is silent in the SSR environment — nothing is stubbed there', () => {
        // A constant shared between SERVER modules is never handed to a
        // browser, so scolding its author would be noise.
        expect(warnFor('ssr')).toEqual([]);
    });
});

describe('sigxServer — the moved-mount lint (#563)', () => {
    const ENTRY = `
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { serverFns } from 'virtual:sigx-server-fns';
export default { fetch(request) {
    if (matchesServerFn(request)) return handleServerFnRequest(request, { functions: serverFns });
    return new Response('doc');
} };
`;
    /** Transform `src/entry.ts` and collect the plugin's warnings. */
    function warnFor(entry: string, options?: Parameters<typeof sigxServer>[0]): string[] {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART }, 'build', options);
        try {
            const warnings: string[] = [];
            plugin.transform.call(
                { environment: { name: 'ssr' }, warn: (m: string) => warnings.push(m) },
                entry,
                join(root, 'src/entry.ts')
            );
            return warnings;
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }

    it('warns when the entry takes the default base but the build moved the mount', () => {
        const warnings = warnFor(ENTRY, { base: '/rpc' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("mounts server functions at '/rpc'");
        expect(warnings[0]).toContain('serverFnBase');
    });

    it('is silent on a stock build — the default base is the 95% case', () => {
        expect(warnFor(ENTRY)).toEqual([]);
    });

    it('is silent for the default written with a cosmetic trailing slash', () => {
        // `/rpc` and `/rpc/` route identically, so a base that differs from
        // the default only in slashes has not moved anything.
        expect(warnFor(ENTRY, { base: '/_sigx/fn/' })).toEqual([]);
    });

    it('is silent once the entry passes the build value', () => {
        const fixed = ENTRY.replace('matchesServerFn(request)', 'matchesServerFn(request, serverFnBase)');
        expect(warnFor(fixed, { base: '/rpc' })).toEqual([]);
    });

    it('follows an aliased import', () => {
        const aliased = ENTRY.replace(
            'matchesServerFn }',
            'matchesServerFn as isFn }'
        ).replace('matchesServerFn(request)', 'isFn(request)');
        expect(warnFor(aliased, { base: '/rpc' })).toHaveLength(1);
    });

    it('says nothing about a file that does not route', () => {
        expect(warnFor(`export const x = 1;\n`, { base: '/rpc' })).toEqual([]);
    });
});

describe('sigxServer — inline extraction (non-matching files)', () => {
    let plugin: any;
    let root: string;

    /** transform-hook context: this.error must throw, like rollup's. */
    const ctx = (env: string, warnings: string[] = []) => ({
        environment: { name: env },
        warn: (m: string) => warnings.push(m),
        error: (m: string): never => {
            throw new Error(m);
        }
    });

    beforeAll(() => {
        ({ plugin, root } = makeProject({}, 'serve'));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const INLINE = `import { serverFn } from '@sigx/server';\nexport const ping = serverFn(async (rq) => 1);`;

    it('client env: swaps module-scope declarations for stubs', () => {
        const result = plugin.transform.call(ctx('client'), INLINE, join(root, 'src/Page.tsx'));
        expect(result.code).toContain('__serverFnStub(');
        expect(result.code).toMatch(/__serverFnStub\("src\/Page\.tsx\/ping", "ping", "\/_sigx\/fn", "[0-9a-f]{8}"\)/);
        expect(result.code).not.toContain('async (rq) => 1');
    });

    it('ssr env: keeps the body and appends the mangled export', () => {
        const result = plugin.transform.call(ctx('ssr'), INLINE, join(root, 'src/Page.tsx'));
        expect(result.code).toContain('async (rq) => 1');
        expect(result.code).toContain('export const __sigxSrvFn_ping = ping;');
    });

    it('registers inline keys in the registry under the mangled export', () => {
        plugin.transform.call(ctx('client'), INLINE, join(root, 'src/Page.tsx'));
        const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
        expect(registry).toMatch(
            /\["src\/Page\.tsx\/ping"\]: \{ version: "[0-9a-f]{8}", load: \(\) => import\("\/src\/Page\.tsx"\)\.then\(m => m\["__sigxSrvFn_ping"\]\) \},/
        );
    });

    it('never serves the original module when inline extraction fails to parse', () => {
        const file = join(root, 'src/Live.tsx');
        const good = `import { serverFn } from '@sigx/server';\nexport const ping = serverFn(async (rq) => 'SECRET_BODY');`;
        const first = plugin.transform.call(ctx('client'), good, file);
        expect(first.code).not.toContain('SECRET_BODY');

        const broken = good + '\nconst oops = {';
        const fallback = plugin.transform.call(ctx('client'), broken, file);
        expect(fallback.code).toContain('__serverFnStub'); // last good client output
        expect(fallback.code).not.toContain('SECRET_BODY');

        const fresh = plugin.transform.call(
            ctx('client'),
            `import { serverFn } from '@sigx/server';\nconst x = serverFn(async (rq) => 'SECRET_BODY');\nconst broken = {`,
            join(root, 'src/NeverSeen.tsx')
        );
        expect(fresh.code).toMatch(/^throw new Error/);
        expect(fresh.code).not.toContain('SECRET_BODY');
    });

    it('capture violations are hard errors', () => {
        const bad = `import { serverFn } from '@sigx/server';\nconst T = {};\nexport const leak = serverFn(async (rq) => T);`;
        expect(() =>
            plugin.transform.call(ctx('client'), bad, join(root, 'src/Bad.tsx'))
        ).toThrow(/module-scope binding "T"/);
    });

    it('requireAuthorization fails the build with a file and line (#489/#611)', () => {
        const bare =
            `import { serverFn } from '@sigx/server';\n` +
            `export const read = serverFn(async (rq) => 1);`;
        const { plugin: gated, root: gatedRoot } = makeProject(
            { 'src/api.server.ts': bare },
            'build',
            { requireAuthorization: true }
        );
        try {
            expect(() =>
                gated.transform.call(ctx('client'), bare, join(gatedRoot, 'src/api.server.ts'))
            ).toThrow(/api\.server\.ts:2:21 .*has no decided access policy/s);
        } finally {
            rmSync(gatedRoot, { recursive: true, force: true });
        }
    });

    it("requireAuthorization 'warn' reports without failing (#489)", () => {
        const bare =
            `import { serverFn } from '@sigx/server';\n` +
            `export const read = serverFn(async (rq) => 1);`;
        const { plugin: warned, root: warnRoot } = makeProject(
            { 'src/api.server.ts': bare },
            'build',
            { requireAuthorization: 'warn' }
        );
        try {
            const warnings: string[] = [];
            const result = warned.transform.call(
                ctx('client', warnings),
                bare,
                join(warnRoot, 'src/api.server.ts')
            );
            expect(result.code).toContain('__serverFnStub(');
            expect(warnings.some((w) => w.includes('has no decided access policy'))).toBe(true);
        } finally {
            rmSync(warnRoot, { recursive: true, force: true });
        }
    });

    it('a configured serverApp passes a bare fn — the app default decides it (rfc-server-v4 §5)', () => {
        const bare =
            `import { serverFn } from '@sigx/server';\n` +
            `export const read = serverFn(async (rq) => 1);`;
        const { plugin: withApp, root: appRoot } = makeProject(
            { 'src/api.server.ts': bare },
            'build',
            { requireAuthorization: true, serverApp: '/src/server-app.ts' }
        );
        try {
            const result = withApp.transform.call(
                ctx('client'),
                bare,
                join(appRoot, 'src/api.server.ts')
            );
            expect(result.code).toContain('__serverFnStub(');
        } finally {
            rmSync(appRoot, { recursive: true, force: true });
        }
    });

    it('a leftover preset component file is skipped untouched — nothing recognizes it anymore (rfc-server-v4 §1.5)', () => {
        // The quick-scan patterns list only serverFn/serverStream now: a
        // file whose only `@sigx/server` value import is the (removed)
        // `serverFnPreset` never reaches the inline extractor, and the
        // module fails loudly at IMPORT time instead — `serverFnPreset` is
        // not an export of @sigx/server.
        const leftover =
            `import { serverFnPreset } from '@sigx/server';\n` +
            `const authed = serverFnPreset({ use: [] });\n` +
            `export const load = authed(async (rq) => 1);`;
        const result = plugin.transform.call(
            ctx('client'),
            leftover,
            join(root, 'src/Preset.tsx')
        );
        expect(result ?? null).toBeNull();
    });

    it('serverFn inside a component is a hard error with a location', () => {
        const bad =
            `import { serverFn } from '@sigx/server';\n` +
            `export const C = () => {\n    const f = serverFn(async (rq) => 1);\n    return f;\n};`;
        expect(() =>
            plugin.transform.call(ctx('client'), bad, join(root, 'src/Nested.tsx'))
        ).toThrow(/Nested\.tsx:3:15/);
    });

    it('skips re-runs over its own stub output without clobbering the cache', () => {
        const file = join(root, 'src/cart.server.ts');
        const first = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            CART,
            file
        );
        // Second pass over our own output: no re-transform, and the registry
        // still knows the key afterwards.
        const echo = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            first.code,
            file
        );
        expect(echo).toBeNull();
        const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
        expect(registry).toMatch(/\["src\/cart\.server\.ts\/addToCart"\]: \{ version: "[0-9a-f]{8}"/);
    });

    it('does not warn when only other values are imported', () => {
        const warnings: string[] = [];
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import { isServerFnError } from '@sigx/server';\nconst handle = (e: unknown) => isServerFnError(e);`,
            join(root, 'src/Errors.ts')
        );
        expect(warnings).toHaveLength(0);
    });

    it('does not warn for @sigx/server-renderer imports or type-only imports', () => {
        const warnings: string[] = [];
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import { createSSR } from '@sigx/server-renderer';\nconst serverFn = (x) => x; serverFn(1);`,
            join(root, 'src/a.ts')
        );
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import type { ServerFnContext } from '@sigx/server';\nconst use = (serverFn: ServerFnContext) => serverFn(0 as never);`,
            join(root, 'src/b.ts')
        );
        expect(warnings).toHaveLength(0);
    });
});

describe('sigxServer — rev 2: role, endpoint, stable keys, scan (#320)', () => {
    // A named package.json in the project root makes stable ids
    // deterministic (no dependence on manifests above the temp dir).
    const APP = { 'package.json': '{"name": "@test/app"}', 'src/cart.server.ts': CART };
    const noWarn = { warn: () => {} };

    it('exposes { role, base, endpoint } on plugin.api for cross-plugin introspection', () => {
        // rfc-deploy §3.3: the future `ssr.adapter` reads this to raise the
        // role:'client' × adapter config error.
        const defaults = sigxServer() as any;
        expect(defaults.api).toEqual({
            role: 'auto',
            base: '/_sigx/fn',
            endpoint: '/_sigx/fn',
            resolveServerFn: expect.any(Function)
        });
        const client = sigxServer({
            role: 'client',
            base: '/rpc',
            endpoint: 'https://api.example.com/rpc'
        }) as any;
        expect(client.api).toEqual({
            role: 'client',
            base: '/rpc',
            endpoint: 'https://api.example.com/rpc',
            resolveServerFn: expect.any(Function)
        });
    });

    it('registers ONE record per key — { version, load } — and the version hashes the definition, not its spelling (rfc-server-v5 §4.2/§4.3)', () => {
        // The former hashed twin (`<name>_fn_<hash8>`) is gone: the key is
        // the only route, and what used to be the twin is now the `version`
        // tag beside the loader. That tag is seeded from the parsed call, so
        // a reformat or a comment keeps it while a semantic edit bumps it —
        // the property that makes a 409 mean "different build", never
        // "different whitespace".
        const RECORD =
            /\["@test\/app\/src\/cart\.server\.ts\/addToCart"\]: \{ version: "([0-9a-f]{8})", load: \(\) => import\("\/src\/cart\.server\.ts"\)\.then\(m => m\["addToCart"\]\) \},/;
        const versionOf = (source: string): string => {
            const { plugin, root } = makeProject({ ...APP, 'src/cart.server.ts': source });
            try {
                const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns')) as string;
                // Exactly one computed-key line for the one function — no
                // second (hashed) registration of the same loader.
                expect(registry.match(/^\s+\["[^"]+"\]:/gm)).toHaveLength(1);
                expect(registry).not.toMatch(/_fn_[0-9a-f]{8}/);
                const match = RECORD.exec(registry);
                if (!match) throw new Error(`no { version, load } record for addToCart in:\n${registry}`);
                return match[1];
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        };
        const base = versionOf(CART);
        expect(base).toMatch(/^[0-9a-f]{8}$/);
        // Reformatted + commented: same AST, same version.
        const REFORMATTED = CART.replace(
            'serverFn(async (rq, id: string) => db.cart.add(id));',
            'serverFn(\n    // add one line\n    async (rq, id: string) =>   db.cart.add( id )\n);'
        );
        expect(REFORMATTED).not.toBe(CART);
        expect(versionOf(REFORMATTED)).toBe(base);
        // A body edit: different version.
        expect(versionOf(CART.replace('db.cart.add(id)', 'db.cart.addOne(id)'))).not.toBe(base);
    });

    it("role: 'client' stubs EVERY environment with the stable key and the baked endpoint", () => {
        const { plugin, root } = makeProject(APP, 'build', {
            role: 'client',
            endpoint: 'https://api.example.com/_sigx/fn'
        });
        try {
            for (const env of ['ssr', 'custom-terminal', 'client']) {
                const result = plugin.transform.call(
                    { environment: { name: env }, ...noWarn },
                    CART,
                    join(root, 'src/cart.server.ts')
                );
                // The same stub call as every other role since rfc-server-v5
                // §1.3: key, name, endpoint, version — nothing role-specific.
                expect(result.code).toMatch(
                    /__serverFnStub\("@test\/app\/src\/cart\.server\.ts\/addToCart", "addToCart", "https:\/\/api\.example\.com\/_sigx\/fn", "[0-9a-f]{8}"\)/
                );
                expect(result.code).not.toContain('db.cart.add');
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    /** load-hook context: `this.error` throws, like rollup's. */
    const loadCtx = (env: string) => ({
        environment: { name: env },
        warn: () => {},
        error: (m: string): never => {
            throw new Error(m);
        }
    });

    it("importing 'virtual:sigx-server-fns' from the client environment is a build error", () => {
        // A client-side registry would be a table of dynamic imports of the
        // STUB modules — every `load()` an RPC to itself. Loud, not silent.
        const { plugin, root } = makeProject(APP);
        try {
            const id = plugin.resolveId('virtual:sigx-server-fns');
            expect(() => plugin.load.call(loadCtx('client'), id)).toThrow(/server-only/);
            // The control: the ssr environment gets the registry.
            expect(plugin.load.call(loadCtx('ssr'), id)).toContain('export const serverFns = {');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("role: 'client' refuses the registry import — there is no server in this build", () => {
        const { plugin, root } = makeProject(APP, 'build', { role: 'client' });
        try {
            const id = plugin.resolveId('virtual:sigx-server-fns');
            expect(() => plugin.load.call(loadCtx('ssr'), id)).toThrow(/role: 'client'/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("role: 'client' emits no registry chunk and mounts no dev endpoint", () => {
        const { plugin, root } = makeProject(APP, 'build', { role: 'client' });
        try {
            const emitted: unknown[] = [];
            plugin.buildStart.call({
                environment: { name: 'ssr' },
                emitFile: (f: unknown) => emitted.push(f)
            });
            expect(emitted).toHaveLength(0);

            const used: unknown[] = [];
            plugin.configureServer({
                middlewares: { use: (fn: unknown) => used.push(fn) },
                watcher: { add: () => {} }
            });
            expect(used).toHaveLength(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('loads the ambient-request seam eagerly, so dev matches prod (#309)', async () => {
        const { plugin, root } = makeProject(APP);
        try {
            const loaded: string[] = [];
            plugin.configureServer({
                middlewares: { use: () => {} },
                watcher: { add: () => {} },
                ssrLoadModule: (id: string) => {
                    loaded.push(id);
                    return Promise.resolve({});
                }
            });
            await Promise.resolve();
            // In prod the seam registers when the server imports
            // @sigx/server/node; in dev nothing would load it before the
            // first RPC, leaving SSR-time rq.request throwing until then.
            expect(loaded).toEqual(['@sigx/server/node']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('the dev endpoint is built with `functions` — the registry shape, not a bespoke resolver (rfc-server-v5 §4.3)', async () => {
        // One code path resolves keys in dev and prod: the endpoint's
        // `functions`. The dev middleware hands `createServerFnHandler` a
        // live `key → { version, load }` twin of the registry chunk, so the
        // skew check (and the #555 own-property guard) apply under `vite dev`
        // exactly as they do in production.
        const { plugin, root } = makeProject(APP, 'serve');
        try {
            type Registry = Record<string, { version: string; load(): Promise<unknown> }>;
            const captured: { functions?: Registry; resolve?: unknown }[] = [];
            const nodeEntry = {
                createServerFnHandler: (opts: { functions?: Registry; resolve?: unknown }) => {
                    captured.push(opts);
                    return async () => {};
                }
            };
            let middleware:
                | ((req: unknown, res: unknown, next: (err?: unknown) => void) => Promise<void>)
                | undefined;
            plugin.configureServer({
                middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
                watcher: { add: () => {} },
                ssrLoadModule: (id: string) =>
                    Promise.resolve(id === '@sigx/server/node' ? nodeEntry : { addToCart: 'the live fn' })
            });
            if (!middleware) throw new Error('configureServer mounted no middleware');
            await middleware({ url: '/_sigx/fn/anything' }, {}, () => {});

            expect(captured).toHaveLength(1);
            const { functions, resolve } = captured[0];
            expect(resolve).toBeUndefined();
            if (!functions) throw new Error('the dev endpoint was built without `functions`');
            // Null-prototype, like the emitted chunk: a wire key named
            // "__proto__" must not find Object.prototype's setter.
            expect(Object.getPrototypeOf(functions)).toBe(null);
            const key = '@test/app/src/cart.server.ts/addToCart';
            expect(Object.keys(functions)).toEqual([key]);
            expect(functions[key].version).toMatch(/^[0-9a-f]{8}$/);
            // The same version the prod chunk would carry for this source.
            expect(plugin.load(plugin.resolveId('virtual:sigx-server-fns'))).toContain(
                `["${key}"]: { version: "${functions[key].version}", load:`
            );
            // load() reaches the live module through ssrLoadModule.
            await expect(functions[key].load()).resolves.toBe('the live fn');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('boots an app without @sigx/server, silently — that miss is expected', async () => {
        const { plugin, root } = makeProject(APP);
        try {
            const warnings: string[] = [];
            expect(() =>
                plugin.configureServer({
                    middlewares: { use: () => {} },
                    watcher: { add: () => {} },
                    config: { logger: { warn: (m: string) => warnings.push(m) } },
                    ssrLoadModule: () =>
                        Promise.reject(
                            new Error('Failed to resolve import "@sigx/server/node"')
                        )
                })
            ).not.toThrow();
            // The rejection is handled — an unhandled one would fail the run.
            await Promise.resolve();
            await Promise.resolve();
            expect(warnings).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('warns when the seam fails to load for any OTHER reason', async () => {
        const { plugin, root } = makeProject(APP);
        try {
            const warnings: string[] = [];
            plugin.configureServer({
                middlewares: { use: () => {} },
                watcher: { add: () => {} },
                config: { logger: { warn: (m: string) => warnings.push(m) } },
                ssrLoadModule: () => Promise.reject(new SyntaxError('Unexpected token'))
            });
            await Promise.resolve();
            await Promise.resolve();
            // Silently degrading here would leave SSR-time rq.request
            // throwing with nothing to point at.
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('Unexpected token');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("role: 'auto' still emits the registry for the ssr environment", () => {
        const { plugin, root } = makeProject(APP);
        try {
            const emitted: any[] = [];
            plugin.buildStart.call({
                environment: { name: 'ssr' },
                emitFile: (f: unknown) => emitted.push(f)
            });
            expect(emitted).toHaveLength(1);
            expect(emitted[0].fileName).toBe('sigx-server-fns.js');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('`endpoint` (distinct from `base`) is what stubs fetch', () => {
        const { plugin, root } = makeProject(APP, 'build', {
            endpoint: 'https://api.example.com/_sigx/fn'
        });
        try {
            const result = plugin.transform.call(
                { environment: { name: 'client' }, ...noWarn },
                CART,
                join(root, 'src/cart.server.ts')
            );
            expect(result.code).toMatch(
                /__serverFnStub\("@test\/app\/src\/cart\.server\.ts\/addToCart", "addToCart", "https:\/\/api\.example\.com\/_sigx\/fn", "[0-9a-f]{8}"\)/
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('`scan` discovers out-of-root packages: package-qualified ids, absolute specs, cross-build coherence', () => {
        const shared = mkdtempSync(join(tmpdir(), 'sigx-shared-'));
        const roots: string[] = [shared];
        try {
            mkdirSync(join(shared, 'src'), { recursive: true });
            writeFileSync(join(shared, 'package.json'), '{"name": "@acme/shared"}');
            writeFileSync(join(shared, 'src/cart.server.ts'), CART);

            const load = (): string => {
                const { plugin, root } = makeProject({ 'package.json': '{"name": "@test/app"}' }, 'build', {
                    scan: [shared]
                });
                roots.push(root);
                return plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
            };
            const a = load();
            const b = load();

            const stableKey = '"@acme/shared/src/cart.server.ts/addToCart"';
            expect(a).toContain(stableKey);
            // Out-of-root module ⇒ absolute-path import spec, not '/src/…'.
            const record =
                /\["@acme\/shared\/src\/cart\.server\.ts\/addToCart"\]: \{ version: "[0-9a-f]{8}", load: \(\) => import\("([^"]+)"\)/.exec(a);
            if (!record) throw new Error(`no record for the shared fn in:\n${a}`);
            const spec = record[1];
            expect(spec).toContain('sigx-shared-');
            expect(spec).not.toBe('/src/cart.server.ts');
            // Two app builds (different roots) mint IDENTICAL registry keys
            // AND versions for the shared module — the whole point of
            // stable-id seeds: a client built by one app is not skew to a
            // server built by the other.
            const identities = (s: string): string[] =>
                [...s.matchAll(/^\s+\["([^"]+)"\]: \{ version: "([0-9a-f]{8})"/gm)]
                    .map((m) => `${m[1]}@${m[2]}`)
                    .sort();
            expect(identities(a)).toHaveLength(1);
            expect(identities(a)).toEqual(identities(b));
        } finally {
            for (const dir of roots) rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a dev /@fs/ id keys the SAME extraction entry as discovery (no dup registry keys)', () => {
        const shared = mkdtempSync(join(tmpdir(), 'sigx-fs-'));
        const roots = [shared];
        try {
            mkdirSync(join(shared, 'src'), { recursive: true });
            writeFileSync(join(shared, 'package.json'), '{"name": "@acme/fs-pkg"}');
            writeFileSync(join(shared, 'src/cart.server.ts'), CART);
            const { plugin, root } = makeProject(
                { 'package.json': '{"name": "@test/app"}' },
                'serve',
                { scan: [shared] }
            );
            roots.push(root);
            // Vite serves the out-of-root module as an /@fs/ URL; the map key
            // must land on discovery's entry, not mint a second one.
            const fsId = '/@fs/' + join(shared, 'src/cart.server.ts').replace(/\\/g, '/');
            const result = plugin.transform.call(
                { environment: { name: 'client' }, ...noWarn },
                CART,
                fsId
            );
            expect(result.code).toMatch(/__serverFnStub\("@acme\/fs-pkg\/src\/cart\.server\.ts\/addToCart", "addToCart", "\/_sigx\/fn", "[0-9a-f]{8}"\)/);
            const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
            expect(registry.match(/\["@acme\/fs-pkg\/src\/cart\.server\.ts\/addToCart"\]:/g)).toHaveLength(1);
            expect(registry).toMatch(/\["@acme\/fs-pkg\/src\/cart\.server\.ts\/addToCart"\]: \{ version: "[0-9a-f]{8}", load: /);
        } finally {
            for (const dir of roots) rmSync(dir, { recursive: true, force: true });
        }
    });

    it('two files minting one key (duplicate explicit `id`s) is a build ERROR, not a warning (rfc-server-v5 §1.7)', () => {
        // Two functions on one route is a routing bug: the key is the only
        // route now, so "the later registration wins" would silently serve
        // one file's function under the other's calls.
        const FN = (impl: string) =>
            `import { serverFn } from '@sigx/server';\n` +
            `export const add = serverFn({ id: 'cart/add', handler: async (rq, input) => ${impl} });`;
        const { plugin, root } = makeProject({
            'package.json': '{"name": "@test/app"}',
            'src/a.server.ts': FN('1'),
            'src/b.server.ts': FN('2')
        });
        try {
            const warnings: string[] = [];
            let message = '';
            try {
                plugin.load.call(
                    {
                        environment: { name: 'ssr' },
                        warn: (m: string) => warnings.push(m),
                        error: (m: string): never => {
                            throw new Error(m);
                        }
                    },
                    plugin.resolveId('virtual:sigx-server-fns')
                );
            } catch (error) {
                message = (error as Error).message;
            }
            expect(warnings).toEqual([]);
            expect(message).toContain('cart/add/add');
            expect(message).toContain('duplicate explicit `id`');
            expect(message).toContain('cannot share one route');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxServer — api.resolveServerFn (rfc-server §6.4, #312)', () => {
    const API = `
import { serverFn } from '@sigx/server';
export const submitFeedback = serverFn({
    form: true,
    handler: async (rq, input) => input
});
export const getQuote = serverFn(async (rq, i) => i);
`;

    it('resolves a relative specifier (with and without extension) to the stable key + form mark', () => {
        const { plugin, root } = makeProject({ 'src/api.server.ts': API });
        const importer = join(root, 'src/Feedback.tsx');
        for (const spec of ['./api.server', './api.server.ts']) {
            const hit = plugin.api.resolveServerFn(importer, spec, 'submitFeedback');
            expect(hit).toEqual({ key: 'src/api.server.ts/submitFeedback', form: true });
        }
        expect(plugin.api.resolveServerFn(importer, './api.server', 'getQuote')).toEqual({
            key: 'src/api.server.ts/getQuote',
            form: false
        });
    });

    it('resolves an inline serverFn module too', () => {
        const { plugin, root } = makeProject({
            'src/widget.ts': `
import { serverFn } from '@sigx/server';
const save = serverFn({ form: true, handler: async (rq, input) => input });
export const use = () => save;
`
        });
        // Inline extraction happens on transform, not discovery — feed it.
        const file = join(root, 'src/widget.ts');
        plugin.transform.call(
            { environment: { name: 'ssr' }, warn: () => {}, error: () => {} },
            readFileSync(file, 'utf-8'),
            file
        );
        const hit = plugin.api.resolveServerFn(join(root, 'src/App.tsx'), './widget', 'save');
        expect(hit).toEqual({ key: 'src/widget.ts/save', form: true });
    });

    it('returns null for unknown exports, unknown files, and bare specifiers', () => {
        const { plugin, root } = makeProject({ 'src/api.server.ts': API });
        const importer = join(root, 'src/Feedback.tsx');
        expect(plugin.api.resolveServerFn(importer, './api.server', 'nope')).toBeNull();
        expect(plugin.api.resolveServerFn(importer, './missing.server', 'x')).toBeNull();
        expect(plugin.api.resolveServerFn(importer, '@acme/api/feedback.server', 'x')).toBeNull();
    });
});

describe('sigxServer — hotUpdate (#568)', () => {
    /**
     * The re-extract → invalidate-registry path had no coverage at all, and it
     * is what makes a version change propagate: the version tag hashes the
     * function's definition, so every edit to a server function's body mints
     * a new one, and a registry that kept serving the old map would 409
     * every call from the freshly transformed client.
     */
    /** The version the registry text carries for `addToCart`. */
    const versionIn = (registry: string): string => {
        const match = /\["src\/cart\.server\.ts\/addToCart"\]: \{ version: "([0-9a-f]{8})"/.exec(registry);
        if (!match) throw new Error(`no addToCart record in:\n${registry}`);
        return match[1];
    };
    const hotCtx = (): {
        ctx: unknown;
        invalidated: unknown[];
    } => {
        const mod = { id: '\0virtual:sigx-server-fns' };
        const invalidated: unknown[] = [];
        return {
            ctx: {
                environment: {
                    name: 'ssr',
                    moduleGraph: {
                        getModuleById: (id: string) => (id === mod.id ? mod : undefined),
                        invalidateModule: (m: unknown) => invalidated.push(m)
                    }
                }
            },
            invalidated
        };
    };

    const registryOf = (plugin: any): string =>
        plugin.load(plugin.resolveId('virtual:sigx-server-fns')) as string;

    const EDITED = CART.replace('db.cart.add(id)', 'db.cart.addOne(id)');
    const RENAMED = `
import { serverFn } from '@sigx/server';
export const addToBasket = serverFn(async (rq, id: string) => id);
`;

    it('re-extracts an edited server module and invalidates the registry', async () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const before = registryOf(plugin);
            const { ctx, invalidated } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'update',
                file: join(root, 'src/cart.server.ts'),
                read: async () => EDITED
            });
            const after = registryOf(plugin);
            // Same key, NEW version — the whole point of re-extracting.
            expect(after).toContain('["src/cart.server.ts/addToCart"]');
            expect(versionIn(after)).not.toBe(versionIn(before));
            expect(after).not.toBe(before);
            expect(invalidated).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a renamed export replaces the old key', async () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const { ctx } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'update',
                file: join(root, 'src/cart.server.ts'),
                read: async () => RENAMED
            });
            const after = registryOf(plugin);
            expect(after).toContain('addToBasket');
            expect(after).not.toContain('addToCart');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a deleted server module drops out of the registry', async () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const { ctx, invalidated } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'delete',
                file: join(root, 'src/cart.server.ts'),
                read: async () => ''
            });
            expect(registryOf(plugin)).not.toContain('addToCart');
            expect(invalidated).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a mid-edit syntax error keeps the last good extraction', async () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const before = registryOf(plugin);
            const { ctx } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'update',
                file: join(root, 'src/cart.server.ts'),
                read: async () => CART + '\nconst oops = {'
            });
            // Unchanged: an editor saves broken syntax constantly, and
            // dropping the key would 404 every call until the next keystroke.
            expect(registryOf(plugin)).toBe(before);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('says nothing about an unrelated file that never held a serverFn', async () => {
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const { ctx, invalidated } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'update',
                file: join(root, 'src/util.ts'),
                read: async () => 'export const x = 1;'
            });
            // Early return — every keystroke in every file would otherwise
            // invalidate the registry.
            expect(invalidated).toHaveLength(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('re-extracts an INLINE carrier, and survives a graph with no registry module', async () => {
        const INLINE = `
import { serverFn } from '@sigx/server';
export const Page = () => null;
const search = serverFn(async (rq, q: string) => q);
`;
        const { plugin, root } = makeProject({ 'src/cart.server.ts': CART });
        try {
            const file = join(root, 'src/Page.tsx');
            // Transform it once so the plugin knows it is a carrier.
            plugin.transform.call(
                { environment: { name: 'client' }, warn: () => {}, error: (m: string) => { throw new Error(m); } },
                INLINE,
                file
            );
            const { ctx, invalidated } = hotCtx();
            await plugin.hotUpdate.call(ctx, {
                type: 'update',
                file,
                read: async () => INLINE.replace('async (rq, q: string) => q', 'async (rq, q: string) => q + "!"')
            });
            expect(invalidated).toHaveLength(1);

            // A graph without the virtual module (it was never imported) must
            // not throw — `getModuleById` returning undefined is normal.
            await expect(
                plugin.hotUpdate.call(
                    {
                        environment: {
                            name: 'ssr',
                            moduleGraph: { getModuleById: () => undefined, invalidateModule: () => {} }
                        }
                    },
                    { type: 'update', file, read: async () => INLINE }
                )
            ).resolves.toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
