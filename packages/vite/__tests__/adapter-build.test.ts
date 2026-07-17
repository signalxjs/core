/**
 * @vitest-environment node
 *
 * Real-build proof of the deployment build seam (rfc-deploy §3): the
 * virtual:sigx-app artifacts, the emitted sigx-app.js chunk (incl. dedup
 * when the entry also imports the virtual), manualChunks inheritance,
 * adapter.generate ordering, and the fully-bundled edge output with
 * platform + production condition resolution.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
    mkdtempSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    existsSync,
    readFileSync,
    readdirSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { sigxPlugin, type AdapterGenerateContext } from '../src/index';

/** Write a stub package into the fixture's node_modules. */
function stub(root: string, name: string, pkg: Record<string, unknown>, files: Record<string, string>) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', ...pkg }));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
}

/** All bare (non-relative, non-virtual) import specifiers in a chunk. */
function bareImports(code: string): string[] {
    const specs: string[] = [];
    const re = /(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g;
    for (let m = re.exec(code); m; m = re.exec(code)) {
        const spec = m[1];
        if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('\0')) specs.push(spec);
    }
    return specs;
}

describe('external build — sigx-app.js artifacts (real vite)', () => {
    let root: string;
    const generateCalls: Array<{ ctx: AdapterGenerateContext; clientBuilt: boolean; serverBuilt: boolean }> = [];

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'sigx-adapter-ext-'));
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
        writeFileSync(
            join(root, 'index.html'),
            `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div>` +
                `<script type="module" src="/src/entry-client.ts"></script></body></html>`
        );
        // The client entry pulls in the stubbed sigx package so the root
        // manualChunks pin is exercised inside the client environment.
        writeFileSync(join(root, 'src', 'entry-client.ts'), `import { marker } from 'sigx'; console.log(marker);`);
        // The ssr entry ALSO imports the virtual — the dedup case: the
        // emitted sigx-app.js chunk and the entry must share one module.
        writeFileSync(
            join(root, 'src', 'entry-server.ts'),
            `import { template, assets } from 'virtual:sigx-app';\n` +
                `export function createApp(url) { return { url, hasTemplate: template.includes('ssr-outlet'), assets }; }\n` +
                `export { template };\n`
        );
        stub(root, 'sigx', { main: 'index.js', exports: { '.': './index.js' } }, {
            'index.js': `export const marker = 'SIGX_MARKER';\n`
        });
    }, 60_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('emits dist/server/sigx-app.js with the five exports, deduped with the entry import', async () => {
        const { createBuilder } = await import('vite');
        const builder = await createBuilder({
            root,
            logLevel: 'error',
            plugins: [
                sigxPlugin({
                    hmr: false,
                    ssr: {
                        entry: 'src/entry-server.ts',
                        adapter: {
                            name: 'test-node',
                            serverBuild: 'external',
                            generate(ctx) {
                                generateCalls.push({
                                    ctx,
                                    clientBuilt: existsSync(join(ctx.clientOutDir, 'index.html')),
                                    serverBuilt: existsSync(join(ctx.serverOutDir, 'sigx-app.js'))
                                });
                            }
                        }
                    }
                })
            ]
        });
        await builder.buildApp();

        // The materialized module: one import replaces four readFiles.
        const appFile = join(root, 'dist/server/sigx-app.js');
        expect(existsSync(appFile)).toBe(true);
        const mod = await import(/* @vite-ignore */ 'file://' + appFile.replace(/\\/g, '/'));
        expect(mod.template).toContain('<!--ssr-outlet-->');
        expect(mod.template).toContain('/assets/');
        expect(mod.assets.modulepreload[0]).toMatch(/^\/assets\/.+\.js$/);
        expect(mod.manifest['index.html']).toBeTruthy();
        expect(mod.islandsManifest).toBeUndefined();
        expect(mod.resumeManifest).toBeUndefined();

        // manualChunks inheritance: the client environment still pins the
        // sigx family into one chunk.
        const clientAssets = readdirSync(join(root, 'dist/client/assets'));
        expect(clientAssets.some((f) => /^sigx-.*\.js$/.test(f))).toBe(true);

        // Dedup by construction: the entry's `virtual:sigx-app` import
        // resolves to the emitted sibling file — never a second inlined copy
        // of the template.
        const serverFiles = readdirSync(join(root, 'dist/server')).filter((f) => f.endsWith('.js'));
        const withTemplate = serverFiles.filter((f) =>
            // The full comment marker — the fixture source only mentions the
            // bare 'ssr-outlet' string, so this matches the template literal.
            readFileSync(join(root, 'dist/server', f), 'utf-8').includes('<!--ssr-outlet-->')
        );
        expect(withTemplate).toEqual(['sigx-app.js']);
        const entryCode = readFileSync(join(root, 'dist/server/entry-server.js'), 'utf-8');
        expect(entryCode).toMatch(/from\s*["']\.\/sigx-app\.js["']/);

        // adapter.generate ran LAST, over both finished output trees, with
        // absolute paths.
        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0].clientBuilt).toBe(true);
        expect(generateCalls[0].serverBuilt).toBe(true);
        expect(isAbsolute(generateCalls[0].ctx.clientOutDir)).toBe(true);
        expect(generateCalls[0].ctx.ssrInput.replace(/\\/g, '/')).toContain('src/entry-server.ts');
    }, 120_000);
});

describe('bundled build — self-contained edge output (real vite)', () => {
    let root: string;

    beforeAll(() => {
        // Vite derives isProduction from NODE_ENV (vitest sets 'test', a real
        // `vite build` sees it unset and defaults to production) — stub it so
        // the development|production token resolves the way deploy builds do.
        vi.stubEnv('NODE_ENV', 'production');
        root = mkdtempSync(join(tmpdir(), 'sigx-adapter-bundled-'));
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
        writeFileSync(
            join(root, 'index.html'),
            `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div>` +
                `<script type="module" src="/src/entry-client.ts"></script></body></html>`
        );
        writeFileSync(join(root, 'src', 'entry-client.ts'), `console.log('client');`);
        writeFileSync(
            join(root, 'src', 'entry-server.ts'),
            `import 'cf:runtime';\n` +
                `import { plat } from '@test/plat';\n` +
                `import { env } from '@test/env';\n` +
                `import { template } from 'virtual:sigx-app';\n` +
                `export function createApp(url) { return { url, plat, env, template }; }\n`
        );
        // Platform condition: 'workerd' must be picked and 'node' dropped —
        // the conditions array REPLACES Vite's server defaults.
        stub(
            root,
            '@test/plat',
            {
                exports: { '.': { workerd: './workerd.js', node: './node.js', default: './default.js' } }
            },
            {
                'workerd.js': `export const plat = 'PLAT_WORKERD';\n`,
                'node.js': `export const plat = 'PLAT_NODE';\n`,
                'default.js': `export const plat = 'PLAT_DEFAULT';\n`
            }
        );
        // The development|production token must resolve to production in a
        // build (the "provably prod" requirement, rfc-deploy §3.1).
        stub(
            root,
            '@test/env',
            {
                exports: { '.': { development: './dev.js', production: './prod.js', default: './default.js' } }
            },
            {
                'dev.js': `export const env = 'ENV_DEV';\n`,
                'prod.js': `export const env = 'ENV_PROD';\n`,
                'default.js': `export const env = 'ENV_DEFAULT';\n`
            }
        );
    }, 60_000);

    afterAll(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    it('inlines deps with platform + prod conditions; only runtimeExternal imports remain', async () => {
        const { createBuilder } = await import('vite');
        const builder = await createBuilder({
            root,
            logLevel: 'error',
            plugins: [
                sigxPlugin({
                    hmr: false,
                    ssr: {
                        entry: 'src/entry-server.ts',
                        adapter: {
                            name: 'test-edge',
                            serverBuild: 'bundled',
                            conditions: ['workerd', 'worker'],
                            runtimeExternal: [/^cf:/]
                        }
                    }
                })
            ]
        });
        await builder.buildApp();

        const serverDir = join(root, 'dist/server');
        const code = readdirSync(serverDir)
            .filter((f) => f.endsWith('.js'))
            .map((f) => readFileSync(join(serverDir, f), 'utf-8'))
            .join('\n');

        // Platform condition picked, node condition dropped.
        expect(code).toContain('PLAT_WORKERD');
        expect(code).not.toContain('PLAT_NODE');
        // Prod token resolved to production.
        expect(code).toContain('ENV_PROD');
        expect(code).not.toContain('ENV_DEV');
        // The virtual is INLINED — a bundled build gets no separate chunk
        // (one self-contained file is the deliverable).
        expect(existsSync(join(serverDir, 'sigx-app.js'))).toBe(false);
        expect(code).toContain('ssr-outlet');
        // Self-contained: every remaining bare import matches runtimeExternal.
        const bare = readdirSync(serverDir)
            .filter((f) => f.endsWith('.js'))
            .flatMap((f) => bareImports(readFileSync(join(serverDir, f), 'utf-8')));
        expect(bare.length).toBeGreaterThan(0); // cf:runtime survives…
        expect(bare.every((s) => /^cf:/.test(s))).toBe(true); // …and nothing else does
    }, 120_000);
});
