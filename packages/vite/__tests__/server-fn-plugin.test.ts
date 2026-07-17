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

describe('sigxServer — dev lint', () => {
    let plugin: any;
    let root: string;

    beforeAll(() => {
        ({ plugin, root } = makeProject({}, 'serve'));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('warns when serverFn appears in a non-matching file', () => {
        const warnings: string[] = [];
        const result = plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import { serverFn } from '@sigx/server';\nexport const leak = serverFn(async (rq) => 1);`,
            join(root, 'src/Page.tsx')
        );
        expect(result).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('will NOT be extracted');
    });

    it('tolerates compact imports and spaced call sites', () => {
        const warnings: string[] = [];
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import{ serverFn } from '@sigx/server';\nexport const leak = serverFn (async (rq) => 1);`,
            join(root, 'src/Compact.tsx')
        );
        expect(warnings).toHaveLength(1);
    });

    it('catches aliased serverFn imports', () => {
        const warnings: string[] = [];
        plugin.transform.call(
            { environment: { name: 'client' }, warn: (m: string) => warnings.push(m) },
            `import { serverFn as fn } from '@sigx/server';\nexport const leak = fn(async (rq) => 1);`,
            join(root, 'src/Aliased.tsx')
        );
        expect(warnings).toHaveLength(1);
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
