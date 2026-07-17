/**
 * @vitest-environment node
 *
 * sigxServer() (rfc-server §3, #305): environment-split transform (client →
 * stubs, SSR → untouched), the virtual registry module, extraction warnings,
 * and the dev lint for unextracted serverFn.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
    command: 'build' | 'serve' = 'build'
): { plugin: any; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'sigx-server-fn-'));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
    const plugin = sigxServer() as any;
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
        expect(result.code).toMatch(/__serverFnStub\("addToCart_fn_[0-9a-f]{8}", "addToCart", "\/_sigx\/fn"\)/);
        expect(result.code).toContain('__serverOnly("auditLog"');
        expect(result.code).not.toContain('db.cart.add');
    });

    it('leaves the module untouched in the SSR environment', () => {
        const result = plugin.transform.call(
            { environment: { name: 'ssr' }, warn: () => {} },
            CART,
            join(root, 'src/cart.server.ts')
        );
        expect(result).toBeNull();
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
