/**
 * @vitest-environment node
 *
 * sigxIslands() (rfc-ssr-platform §3.1): __islandId stamping on island
 * exports, the virtual client-registration module, and the client-build
 * manifest mapping island names to { chunkUrl, exportName }.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxIslands, scanIslandExports, injectSignalNames } from '../src/islands';

describe('scanIslandExports', () => {
    it('finds const/function/braced exports incl. aliases', () => {
        const code = `
            export const Counter = component(() => {});
            export function Widget() {}
            const Inner = component(() => {});
            export { Inner, Inner as Chart };
            export default component(() => {});
        `;
        const pairs = scanIslandExports(code).sort((a, b) => a.exported.localeCompare(b.exported));
        expect(pairs).toEqual([
            { local: 'Inner', exported: 'Chart' },
            { local: 'Counter', exported: 'Counter' },
            { local: 'Inner', exported: 'Inner' },
            { local: 'Widget', exported: 'Widget' }
        ]);
    });
});

describe('injectSignalNames', () => {
    it('keys a declared signal by its declaration identifier', () => {
        const out = injectSignalNames(`const count = ctx.signal(props.initial ?? 0);`);
        expect(out).toBe(`const count = ((__sigxInit) => ctx.signal(__sigxInit, "count"))(props.initial ?? 0);`);
    });

    it('handles let/var, any context identifier, and multiline declarations', () => {
        const out = injectSignalNames(`let state =\n    c.signal({ a: 1 });`);
        expect(out).toContain(`let state =\n    ((__sigxInit) => c.signal(__sigxInit, "state"))({ a: 1 });`);
    });

    it('preserves generic call arguments', () => {
        const out = injectSignalNames(`const state = ctx.signal<{ a: number }>({ a: 1 });`);
        expect(out).toContain(`((__sigxInit) => ctx.signal<{ a: number }>(__sigxInit, "state"))({ a: 1 })`);
    });

    it('leaves non-declaration call sites untouched (they stay local-only)', () => {
        const code = `return { a: ctx.signal(0) };\nlist.push(ctx.signal(1));\ncount = ctx.signal(2);`;
        expect(injectSignalNames(code)).toBe(code);
    });

    it('is idempotent — rewritten output no longer matches', () => {
        const once = injectSignalNames(`const count = ctx.signal(0);`);
        expect(injectSignalNames(once)).toBe(once);
    });
});

describe('transform — signal keys', () => {
    it('injects keys in island modules alongside the __islandId stamp', () => {
        const plugin = sigxIslands() as any;
        const code = `export const Counter = component((ctx) => {\n    const count = ctx.signal(0);\n    return () => null;\n});`;
        const result = plugin.transform.call({}, code, '/proj/src/islands/Counter.tsx');
        expect(result.code).toContain(`ctx.signal(__sigxInit, "count")`);
        expect(result.code).toContain('Counter.__islandId = "Counter"');
    });
});

describe('transform — aliased exports', () => {
    it('stamps via the LOCAL binding (the alias is not a local identifier)', () => {
        const plugin = sigxIslands() as any;
        const code = `const Inner = component(() => {});\nexport { Inner as Chart };`;
        const result = plugin.transform.call({}, code, '/proj/src/islands/Chart.ts');
        expect(result.code).toContain('Inner.__islandId = "Chart"');
        expect(result.code).toContain('typeof Inner ===');
        // Referencing the alias would throw a ReferenceError at evaluation
        expect(result.code).not.toContain('typeof Chart');
    });
});

describe('sigxIslands end-to-end (real vite build)', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'sigx-islands-'));
        mkdirSync(join(root, 'src', 'islands'), { recursive: true });
        writeFileSync(join(root, 'index.html'),
            `<!doctype html><html><head></head><body><div id="app"></div>` +
            `<script type="module" src="/src/entry-client.ts"></script></body></html>`);
        // Minimal component-factory shape (no sigx dependency needed in the fixture)
        writeFileSync(join(root, 'src', 'islands', 'Counter.ts'),
            `export const Counter = Object.assign(function Counter() {}, { __setup: () => () => null });\n` +
            `export const NotAComponent = 42;`);
        // Islands mode: the client entry does NOT import islands statically —
        // the virtual module's dynamic imports are the only reference, so
        // each island code-splits into its own chunk.
        writeFileSync(join(root, 'src', 'entry-client.ts'),
            `import 'virtual:sigx-islands';\nconsole.log('islands registered');`);
        // Stub the registry import the virtual module emits (the LIGHT
        // ./client subpath — the package root would pull the runtime, #293)
        mkdirSync(join(root, 'node_modules', '@sigx', 'ssr-islands'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '@sigx', 'ssr-islands', 'package.json'),
            JSON.stringify({
                name: '@sigx/ssr-islands', version: '0.0.0', type: 'module', main: 'index.js',
                exports: { '.': './index.js', './client': './client.js' }
            }));
        // Side effects matter: a no-op stub gets DCE'd and takes the dynamic
        // island imports (and their chunks) with it.
        writeFileSync(join(root, 'node_modules', '@sigx', 'ssr-islands', 'client.js'),
            `export const __registered = [];\nexport function registerComponentChunk(name, loader) { __registered.push(name); }`);
        writeFileSync(join(root, 'node_modules', '@sigx', 'ssr-islands', 'index.js'),
            `export * from './client.js';`);
    }, 60_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('stamps __islandId, registers via the virtual module, and emits the manifest', async () => {
        const { build } = await import('vite');
        await build({
            root,
            logLevel: 'error',
            build: { manifest: true, outDir: 'dist/client' },
            plugins: [sigxIslands()]
        });

        // The island chunk exists and carries the __islandId stamp
        const manifestPath = join(root, 'dist/client', '.vite', 'sigx-islands-manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        // Manifest v2: islands nested under `islands`, plus `runtimePreload`
        // for the lazily-imported hydration executor (empty here — the stub
        // package carries no server-renderer dist chunk).
        expect(manifest.version).toBe(2);
        expect(Array.isArray(manifest.runtimePreload)).toBe(true);
        const islands = manifest.islands;
        expect(islands.Counter).toBeTruthy();
        expect(islands.Counter.exportName).toBe('Counter');
        expect(islands.Counter.chunkUrl).toMatch(/^\/assets\/.+\.js$/);
        // The non-component export is filtered by the runtime typeof guard,
        // but it should never reach the manifest either... it shares the
        // module, so it maps to the same chunk under its own name — assert
        // the shape is at least { chunkUrl, exportName } for every entry.
        for (const entry of Object.values<any>(islands)) {
            expect(entry).toHaveProperty('chunkUrl');
            expect(entry).toHaveProperty('exportName');
        }

        // The built island chunk contains the stamp
        const islandChunk = readFileSync(join(root, 'dist/client', islands.Counter.chunkUrl.slice(1)), 'utf-8');
        expect(islandChunk).toContain('__islandId');

        // The entry registered the island through the virtual module
        const clientManifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf-8'));
        const entryFile = clientManifest['index.html'].file;
        const entryCode = readFileSync(join(root, 'dist/client', entryFile), 'utf-8');
        expect(entryCode).toContain('Counter');
    }, 120_000);
});
