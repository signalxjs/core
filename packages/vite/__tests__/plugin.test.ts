/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { mergeConfig } from 'vite';
import { sigxPlugin } from '../src/index';

// ============================================================================
// Helpers
// ============================================================================

const SIGX_CORE_PACKAGES = [
    'sigx',
    '@sigx/reactivity',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/server-renderer',
];

/** Invoke the plugin's `config` hook the way Vite does (it may be async). */
async function runConfigHook(
    userConfig: any,
    command: 'serve' | 'build',
    options: Parameters<typeof sigxPlugin>[0] = {}
): Promise<any> {
    const plugin: any = sigxPlugin(options);
    return await plugin.config(userConfig, { command, mode: command === 'serve' ? 'development' : 'production' });
}

/** A temp project root with the given package.json contents (or none). */
let tmpRoots: string[] = [];
function makeProjectRoot(pkgJson?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigx-vite-plugin-test-'));
    if (pkgJson) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson), 'utf-8');
    }
    tmpRoots.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tmpRoots) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpRoots = [];
});

// ============================================================================
// optimizeDeps.exclude (dev)
// ============================================================================

describe('config hook — optimizeDeps.exclude (serve)', () => {
    it('always excludes the core packages (floor), even with no package.json', async () => {
        const root = makeProjectRoot(); // no package.json
        const config = await runConfigHook({ root }, 'serve');

        for (const pkg of SIGX_CORE_PACKAGES) {
            expect(config.optimizeDeps.exclude).toContain(pkg);
        }
    });

    it('excludes every @sigx/* dependency and devDependency from the project package.json', async () => {
        const root = makeProjectRoot({
            name: 'consumer-app',
            dependencies: {
                'sigx': '^0.6.0',
                '@sigx/store': '^0.6.0',
                '@sigx/router': '^0.6.0',
                'express': '^4.0.0',
            },
            devDependencies: {
                '@sigx/vite': '^0.6.0',
                '@sigx/daisyui': '^0.6.0',
                'vite': '^8.0.0',
            },
        });
        const config = await runConfigHook({ root }, 'serve');
        const exclude: string[] = config.optimizeDeps.exclude;

        // Companions from dependencies AND devDependencies
        expect(exclude).toContain('@sigx/store');
        expect(exclude).toContain('@sigx/router');
        expect(exclude).toContain('@sigx/daisyui');
        expect(exclude).toContain('@sigx/vite');
        // Core floor still present
        for (const pkg of SIGX_CORE_PACKAGES) {
            expect(exclude).toContain(pkg);
        }
        // Non-sigx packages are untouched
        expect(exclude).not.toContain('express');
        expect(exclude).not.toContain('vite');
        // No duplicates (sigx is both a dep and in the floor)
        expect(new Set(exclude).size).toBe(exclude.length);
    });

    it('falls back to the core floor on malformed package.json', async () => {
        const root = makeProjectRoot();
        fs.writeFileSync(path.join(root, 'package.json'), 'not json{', 'utf-8');
        const config = await runConfigHook({ root }, 'serve');

        expect(config.optimizeDeps.exclude).toEqual(expect.arrayContaining(SIGX_CORE_PACKAGES));
        expect(config.optimizeDeps.exclude).toHaveLength(SIGX_CORE_PACKAGES.length);
    });

    it("merges with (not over) the user's own optimizeDeps.exclude via Vite's config merge", async () => {
        const root = makeProjectRoot({
            dependencies: { '@sigx/store': '^0.6.0' },
        });
        const userConfig = {
            root,
            optimizeDeps: { exclude: ['some-user-package'] },
        };
        const pluginConfig = await runConfigHook(userConfig, 'serve');
        const merged: any = mergeConfig(userConfig, pluginConfig);

        expect(merged.optimizeDeps.exclude).toContain('some-user-package');
        expect(merged.optimizeDeps.exclude).toContain('@sigx/store');
        expect(merged.optimizeDeps.exclude).toContain('@sigx/reactivity');
    });
});

// ============================================================================
// ssr.noExternal
// ============================================================================

describe('config hook — ssr.noExternal', () => {
    it.each(['serve', 'build'] as const)('keeps the whole @sigx family in the SSR graph (%s)', async (command) => {
        const root = makeProjectRoot({});
        const config = await runConfigHook({ root }, command);
        const noExternal: (string | RegExp)[] = config.ssr.noExternal;

        expect(noExternal).toContain('sigx');
        const regexes = noExternal.filter((e): e is RegExp => e instanceof RegExp);
        expect(regexes.some(re => re.test('@sigx/store'))).toBe(true);
        expect(regexes.some(re => re.test('@sigx/reactivity'))).toBe(true);
        expect(regexes.some(re => re.test('not-sigx'))).toBe(false);
    });

    it("merges with the user's own ssr.noExternal via Vite's config merge", async () => {
        const root = makeProjectRoot({});
        const userConfig = { root, ssr: { noExternal: ['user-ssr-package'] } };
        const pluginConfig = await runConfigHook(userConfig, 'serve');
        const merged: any = mergeConfig(userConfig, pluginConfig);

        expect(merged.ssr.noExternal).toContain('user-ssr-package');
        expect(merged.ssr.noExternal).toContain('sigx');
    });
});

// ============================================================================
// Build-mode dedupe (unchanged behavior, pinned)
// ============================================================================

describe('config hook — build', () => {
    it('still dedupes the core packages and pins the shared sigx chunk', async () => {
        const config = await runConfigHook({}, 'build');

        expect(config.resolve.dedupe).toEqual(SIGX_CORE_PACKAGES);
        const manualChunks = config.build.rollupOptions.output.manualChunks;
        expect(manualChunks('/x/node_modules/@sigx/reactivity/dist/index.js')).toBe('sigx');
        expect(manualChunks('/x/node_modules/lodash/index.js')).toBeUndefined();
    });
});

// ============================================================================
// HMR websocket port
// ============================================================================

describe('config hook — HMR websocket port', () => {
    let root: string;
    beforeAll(() => {
        root = makeProjectRoot({});
    });

    it('picks a free port in middleware mode (instead of Vite defaulting to 24678)', async () => {
        const config = await runConfigHook({ root, server: { middlewareMode: true } }, 'serve');

        expect(config.server).toBeDefined();
        // Emitted under server.ws — server.hmr.* is deprecated in Vite 8.
        expect(typeof config.server.ws.port).toBe('number');
        expect(config.server.ws.port).toBeGreaterThan(0);
        expect(config.server.hmr).toBeUndefined();
    });

    it('does not touch server config outside middleware mode', async () => {
        const config = await runConfigHook({ root }, 'serve');
        expect(config.server).toBeUndefined();
    });

    it('uses the hmrPort plugin option when given', async () => {
        const config = await runConfigHook(
            { root, server: { middlewareMode: true } },
            'serve',
            { hmrPort: 24999 }
        );
        expect(config.server.ws.port).toBe(24999);
    });

    it('defers to an explicit server.ws.port in the user config', async () => {
        const config = await runConfigHook(
            { root, server: { middlewareMode: true, ws: { port: 12345 } } },
            'serve',
            { hmrPort: 24999 }
        );
        expect(config.server).toBeUndefined();
    });

    it('defers to a legacy server.hmr.port in the user config', async () => {
        const config = await runConfigHook(
            { root, server: { middlewareMode: true, hmr: { port: 12345 } } },
            'serve',
            { hmrPort: 24999 }
        );
        expect(config.server).toBeUndefined();
    });

    it('defers to a user-supplied server.ws.server (and legacy hmr.server)', async () => {
        const fakeServer: any = {};
        for (const server of [
            { middlewareMode: true, ws: { server: fakeServer } },
            { middlewareMode: true, hmr: { server: fakeServer } }
        ]) {
            const config = await runConfigHook({ root, server }, 'serve');
            expect(config.server).toBeUndefined();
        }
    });

    it('stays silent when the websocket is disabled in the user config', async () => {
        for (const server of [
            { middlewareMode: true, ws: false as const },
            { middlewareMode: true, hmr: false as const }
        ]) {
            const config = await runConfigHook({ root, server }, 'serve', { hmrPort: 24999 });
            expect(config.server).toBeUndefined();
        }
    });
});

describe('dev cache headers for workspace dists (#272)', () => {
    it('downgrades Cache-Control to no-cache for /@fs/**/dist/** modules', () => {
        const sigx = sigxPlugin();
        let handler: any;
        (sigx as any).configureServer({ middlewares: { use: (h: any) => { handler = h; } } });

        const run = (url: string) => {
            const headers: Record<string, string> = {};
            const res: any = { setHeader: (n: string, v: string) => { headers[n] = v; } };
            let nexted = false;
            handler({ url }, res, () => { nexted = true; });
            res.setHeader('Cache-Control', 'max-age=31536000,immutable');
            res.setHeader('Content-Type', 'text/javascript');
            return { headers, nexted };
        };

        const dist = run('/@fs/repo/packages/resume/dist/client/index.js?v=abc');
        expect(dist.nexted).toBe(true);
        expect(dist.headers['Cache-Control']).toBe('no-cache');
        expect(dist.headers['Content-Type']).toBe('text/javascript'); // others untouched

        const source = run('/src/entry-client.ts');
        expect(source.headers['Cache-Control']).toBe('max-age=31536000,immutable'); // untouched
    });
});
