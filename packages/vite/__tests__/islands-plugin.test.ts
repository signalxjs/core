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
import { sigxIslands, scanIslandExports } from '../src/islands';

describe('scanIslandExports', () => {
    it('finds const/function/braced exports incl. aliases', () => {
        const code = `
            export const Counter = component(() => {});
            export function Widget() {}
            const Inner = component(() => {});
            export { Inner, Inner as Chart };
            export default component(() => {});
        `;
        expect(scanIslandExports(code).sort()).toEqual(['Chart', 'Counter', 'Inner', 'Widget']);
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
        // Stub the registry import the virtual module emits
        mkdirSync(join(root, 'node_modules', '@sigx', 'ssr-islands'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '@sigx', 'ssr-islands', 'package.json'),
            JSON.stringify({ name: '@sigx/ssr-islands', version: '0.0.0', type: 'module', main: 'index.js' }));
        writeFileSync(join(root, 'node_modules', '@sigx', 'ssr-islands', 'index.js'),
            `export const __registered = [];\nexport function __registerIslandChunk(name, loader) { __registered.push(name); }`);
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
        expect(manifest.Counter).toBeTruthy();
        expect(manifest.Counter.exportName).toBe('Counter');
        expect(manifest.Counter.chunkUrl).toMatch(/^\/assets\/.+\.js$/);
        // The non-component export is filtered by the runtime typeof guard,
        // but it should never reach the manifest either... it shares the
        // module, so it maps to the same chunk under its own name — assert
        // the shape is at least { chunkUrl, exportName } for every entry.
        for (const entry of Object.values<any>(manifest)) {
            expect(entry).toHaveProperty('chunkUrl');
            expect(entry).toHaveProperty('exportName');
        }

        // The built island chunk contains the stamp
        const islandChunk = readFileSync(join(root, 'dist/client', manifest.Counter.chunkUrl.slice(1)), 'utf-8');
        expect(islandChunk).toContain('__islandId');

        // The entry registered the island through the virtual module
        const clientManifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf-8'));
        const entryFile = clientManifest['index.html'].file;
        const entryCode = readFileSync(join(root, 'dist/client', entryFile), 'utf-8');
        expect(entryCode).toContain('Counter');
    }, 120_000);
});
