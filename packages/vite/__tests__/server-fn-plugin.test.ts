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
    const plugin = sigxServer(options) as any;
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
            /__serverFnStub\("addToCart_fn_[0-9a-f]{8}", "addToCart", "\/_sigx\/fn", "src\/cart\.server\.ts#addToCart"\)/
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
        expect(result.code).toContain('addToCart.__sigxKey = "src/cart.server.ts#addToCart";');
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
            // same symbol key twice.
            expect(registry.match(/"addToCart_fn_[0-9a-f]{8}":/g)).toHaveLength(1);
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

    it('resolves and loads symbol → lazy-import records', () => {
        const resolved = plugin.resolveId('virtual:sigx-server-fns');
        expect(resolved).toBe('\0virtual:sigx-server-fns');
        const code = plugin.load(resolved);
        expect(code).toContain('export const serverFns = {');
        expect(code).toMatch(
            /"addToCart_fn_[0-9a-f]{8}": \(\) => import\("\/src\/cart\.server\.ts"\)\.then\(m => m\["addToCart"\]\)/
        );
        // Only serverFn exports register — server-only values have no symbol.
        expect(code).not.toContain('auditLog');
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
        expect(result.code).toMatch(/ping_fn_[0-9a-f]{8}/);
        expect(result.code).not.toContain('async (rq) => 1');
    });

    it('ssr env: keeps the body and appends the mangled export', () => {
        const result = plugin.transform.call(ctx('ssr'), INLINE, join(root, 'src/Page.tsx'));
        expect(result.code).toContain('async (rq) => 1');
        expect(result.code).toContain('export const __sigxSrvFn_ping = ping;');
    });

    it('registers inline symbols in the registry under the mangled export', () => {
        plugin.transform.call(ctx('client'), INLINE, join(root, 'src/Page.tsx'));
        const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
        expect(registry).toMatch(
            /"ping_fn_[0-9a-f]{8}": \(\) => import\("\/src\/Page\.tsx"\)\.then\(m => m\["__sigxSrvFn_ping"\]\)/
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
        // still knows the symbol afterwards.
        const echo = plugin.transform.call(
            { environment: { name: 'client' }, warn: () => {} },
            first.code,
            file
        );
        expect(echo).toBeNull();
        const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
        expect(registry).toMatch(/addToCart_fn_[0-9a-f]{8}/);
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

describe('sigxServer — rev 2: role, endpoint, stable symbols, scan (#320)', () => {
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

    it('dual-registers hashed AND stable symbols to the same import record', () => {
        const { plugin, root } = makeProject(APP);
        try {
            const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
            expect(registry).toMatch(/"addToCart_fn_[0-9a-f]{8}": \(\) => import\("\/src\/cart\.server\.ts"\)/);
            expect(registry).toContain(
                `"@test/app/src/cart.server.ts#addToCart": () => import("/src/cart.server.ts").then(m => m["addToCart"])`
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("role: 'client' stubs EVERY environment with STABLE symbols and the baked endpoint", () => {
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
                expect(result.code).toContain(
                    `__serverFnStub("@test/app/src/cart.server.ts#addToCart", "addToCart", ` +
                    `"https://api.example.com/_sigx/fn", "@test/app/src/cart.server.ts#addToCart")`
                );
                expect(result.code).not.toContain('db.cart.add');
            }
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
                /__serverFnStub\("addToCart_fn_[0-9a-f]{8}", "addToCart", "https:\/\/api\.example\.com\/_sigx\/fn", "@test\/app\/src\/cart\.server\.ts#addToCart"\)/
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

            const stableKey = '"@acme/shared/src/cart.server.ts#addToCart"';
            expect(a).toContain(stableKey);
            // Out-of-root module ⇒ absolute-path import spec, not '/src/…'.
            const spec = /"@acme\/shared\/src\/cart\.server\.ts#addToCart": \(\) => import\("([^"]+)"\)/.exec(a)![1];
            expect(spec).toContain('sigx-shared-');
            expect(spec).not.toBe('/src/cart.server.ts');
            // Two app builds (different roots) mint IDENTICAL registry keys
            // for the shared module — the whole point of stable-id seeds.
            const keys = (s: string): string[] => [...s.matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]).sort();
            expect(keys(a)).toEqual(keys(b));
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
            expect(result.code).toMatch(/__serverFnStub\("addToCart_fn_[0-9a-f]{8}"/);
            const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns'));
            expect(registry.match(/"addToCart_fn_[0-9a-f]{8}":/g)).toHaveLength(1);
            expect(registry).toContain('"@acme/fs-pkg/src/cart.server.ts#addToCart"');
        } finally {
            for (const dir of roots) rmSync(dir, { recursive: true, force: true });
        }
    });

    it('warns when duplicate explicit `id`s collide on a stable symbol', () => {
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
            plugin.load.call(
                { warn: (m: string) => warnings.push(m) },
                plugin.resolveId('virtual:sigx-server-fns')
            );
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('cart/add#add');
            expect(warnings[0]).toContain('duplicate explicit `id`');
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

    it('resolves a relative specifier (with and without extension) to the stable symbol + form mark', () => {
        const { plugin, root } = makeProject({ 'src/api.server.ts': API });
        const importer = join(root, 'src/Feedback.tsx');
        for (const spec of ['./api.server', './api.server.ts']) {
            const hit = plugin.api.resolveServerFn(importer, spec, 'submitFeedback');
            expect(hit).toEqual({ stableSymbol: 'src/api.server.ts#submitFeedback', form: true });
        }
        expect(plugin.api.resolveServerFn(importer, './api.server', 'getQuote')).toEqual({
            stableSymbol: 'src/api.server.ts#getQuote',
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
        expect(hit).toEqual({ stableSymbol: 'src/widget.ts#save', form: true });
    });

    it('returns null for unknown exports, unknown files, and bare specifiers', () => {
        const { plugin, root } = makeProject({ 'src/api.server.ts': API });
        const importer = join(root, 'src/Feedback.tsx');
        expect(plugin.api.resolveServerFn(importer, './api.server', 'nope')).toBeNull();
        expect(plugin.api.resolveServerFn(importer, './missing.server', 'x')).toBeNull();
        expect(plugin.api.resolveServerFn(importer, '@acme/api/feedback.server', 'x')).toBeNull();
    });
});
