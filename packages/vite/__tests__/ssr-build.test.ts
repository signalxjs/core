/**
 * @vitest-environment node
 *
 * SSR build orchestration (rfc-ssr-platform §3.1): `sigx({ ssr: { entry } })`
 * configures the environments/builder API so ONE build produces the client
 * bundle (with its asset manifest) and the server entry — plus the
 * collectAssets manifest → DocumentOptions.assets resolver.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxPlugin } from '../src/index';
import { collectAssets, type ViteManifest } from '../src/ssr';

describe('collectAssets', () => {
    const manifest: ViteManifest = {
        'src/entry-client.tsx': {
            file: 'assets/entry-abc.js',
            isEntry: true,
            imports: ['_shared-def.js'],
            dynamicImports: ['src/sections/TechDetails.tsx'],
            css: ['assets/entry.css']
        },
        '_shared-def.js': {
            file: 'assets/shared-def.js',
            css: ['assets/shared.css']
        },
        'src/sections/TechDetails.tsx': {
            file: 'assets/TechDetails-9.js'
        }
    };

    it('resolves an entry chain: files + css, static imports only', () => {
        const assets = collectAssets(manifest, ['src/entry-client.tsx']);
        expect(assets.modulepreload).toEqual(['/assets/entry-abc.js', '/assets/shared-def.js']);
        expect(assets.stylesheets).toEqual(['/assets/entry.css', '/assets/shared.css']);
        // Dynamic imports are the lazy boundaries — not eagerly preloaded here
        expect(assets.modulepreload).not.toContain('/assets/TechDetails-9.js');
    });

    it('resolves lazy chunks when asked for explicitly (route-driven preloads)', () => {
        const assets = collectAssets(manifest, ['src/sections/TechDetails.tsx']);
        expect(assets.modulepreload).toEqual(['/assets/TechDetails-9.js']);
    });

    it('applies the base prefix and dedupes shared chunks', () => {
        const assets = collectAssets(manifest, ['src/entry-client.tsx', '_shared-def.js'], '/app/');
        expect(assets.modulepreload).toEqual(['/app/assets/entry-abc.js', '/app/assets/shared-def.js']);
    });

    it('warns and skips unknown ids', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const assets = collectAssets(manifest, ['src/nope.tsx']);
        expect(assets).toEqual({ modulepreload: [], stylesheets: [] });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('src/nope.tsx'));
        warn.mockRestore();
    });
});

describe('sigx({ ssr }) build orchestration', () => {
    it('configures builder + environments (client manifest, server entry)', async () => {
        const plugin = sigxPlugin({ ssr: { entry: 'src/entry-server.tsx' } }) as any;
        const config = await plugin.config({}, { command: 'build' });
        expect(config.builder).toBeDefined();
        expect(config.environments.client.build.manifest).toBe(true);
        expect(config.environments.client.build.outDir).toBe('dist/client');
        expect(config.environments.ssr.build.outDir).toBe('dist/server');
        expect(config.environments.ssr.build.rollupOptions.input).toBe('src/entry-server.tsx');
    });

    it('stays out of the way without the ssr option', async () => {
        const plugin = sigxPlugin() as any;
        const config = await plugin.config({}, { command: 'build' });
        expect(config.builder).toBeUndefined();
        expect(config.environments).toBeUndefined();
    });

    describe('end-to-end build (real vite)', () => {
        let root: string;

        beforeAll(() => {
            root = mkdtempSync(join(tmpdir(), 'sigx-ssr-build-'));
            mkdirSync(join(root, 'src'), { recursive: true });
            writeFileSync(join(root, 'index.html'),
                `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div>` +
                `<script type="module" src="/src/entry-client.ts"></script></body></html>`);
            writeFileSync(join(root, 'src', 'entry-client.ts'),
                `import { shared } from './shared'; console.log('client', shared);`);
            writeFileSync(join(root, 'src', 'entry-server.ts'),
                `import { shared } from './shared'; export function createApp(url) { return { url, shared }; }`);
            writeFileSync(join(root, 'src', 'shared.ts'), `export const shared = 'both';`);
        }, 60_000);

        afterAll(() => {
            rmSync(root, { recursive: true, force: true });
        });

        it('one builder run emits the client manifest AND the server entry', async () => {
            const { createBuilder } = await import('vite');
            const builder = await createBuilder({
                root,
                logLevel: 'error',
                plugins: [sigxPlugin({ hmr: false, ssr: { entry: 'src/entry-server.ts' } })]
            });
            await builder.buildApp();

            const manifestPath = join(root, 'dist/client/.vite/manifest.json');
            expect(existsSync(manifestPath)).toBe(true);
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            // An HTML-referenced script entry keys as the html file itself
            const entry = manifest['index.html'];
            expect(entry?.file).toBeTruthy();

            // collectAssets resolves the real manifest end to end
            const assets = collectAssets(manifest, ['index.html']);
            expect(assets.modulepreload[0]).toMatch(/^\/assets\/.+\.js$/);

            // Server entry built (.mjs without a type:module package.json)
            const serverFile = ['entry-server.js', 'entry-server.mjs']
                .map(f => join(root, 'dist/server', f))
                .find(existsSync);
            expect(serverFile).toBeTruthy();
            const serverMod = await import(/* @vite-ignore */ 'file://' + serverFile!.replace(/\\/g, '/'));
            expect(serverMod.createApp('/x')).toEqual({ url: '/x', shared: 'both' });
        }, 120_000);
    });
});
