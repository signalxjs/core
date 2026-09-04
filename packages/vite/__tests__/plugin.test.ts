/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer, mergeConfig, normalizePath } from 'vite';
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

    it('defers to a legacy hmr.port even when ws holds unrelated options', async () => {
        const config = await runConfigHook(
            { root, server: { middlewareMode: true, ws: { protocol: 'wss' }, hmr: { port: 12345 } } },
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

// ============================================================================
// hotUpdate — full-reload for server-only source (#450)
// ============================================================================

describe('hotUpdate — full-reload for server-only source (#450)', () => {
    /**
     * Invoke the plugin's `hotUpdate` hook the way Vite does: bound to a
     * DevEnvironment (`environment`), given a changed `file`, the client-graph
     * `modules` affected, and a `server` whose ssr environment reports whether
     * the file is in the SSR module graph. Returns the payloads the client hot
     * channel received.
     */
    function runHotUpdate(opts: {
        envName?: string;
        file: string;
        clientModules?: unknown[];
        inSsrGraph?: boolean;
        noSsrEnv?: boolean;
        pluginOptions?: Parameters<typeof sigxPlugin>[0];
    }): { sent: unknown[] } {
        const sent: unknown[] = [];
        const plugin: any = sigxPlugin(opts.pluginOptions ?? {});
        const ssrModuleGraph = {
            getModulesByFile: (f: string) =>
                opts.inSsrGraph && f === opts.file ? new Set([{ id: f }]) : undefined
        };
        const environment = {
            name: opts.envName ?? 'client',
            hot: { send: (payload: unknown) => sent.push(payload) }
        };
        // noSsrEnv models a dev server with no `ssr` environment.
        const server = { environments: opts.noSsrEnv ? {} : { ssr: { moduleGraph: ssrModuleGraph } } };
        plugin.hotUpdate.call({ environment }, {
            type: 'update',
            file: opts.file,
            timestamp: 0,
            modules: opts.clientModules ?? [],
            read: () => '',
            server
        });
        return { sent };
    }

    it('full-reloads a server-only source module (in SSR graph, absent from the client graph)', () => {
        const { sent } = runHotUpdate({
            file: '/proj/src/App.tsx',
            clientModules: [],
            inSsrGraph: true
        });
        expect(sent).toEqual([{ type: 'full-reload' }]);
    });

    it('leaves client-graph modules to Vite (in-place component/CSS HMR untouched)', () => {
        const { sent } = runHotUpdate({
            file: '/proj/src/Island.tsx',
            clientModules: [{ id: '/proj/src/Island.tsx' }],
            inSsrGraph: true
        });
        expect(sent).toEqual([]);
    });

    it('does nothing for a source file that is in neither graph', () => {
        const { sent } = runHotUpdate({
            file: '/proj/src/unused.ts',
            clientModules: [],
            inSsrGraph: false
        });
        expect(sent).toEqual([]);
    });

    it('ignores non-JS/TS assets even when server-only', () => {
        const { sent } = runHotUpdate({
            file: '/proj/src/logo.png',
            clientModules: [],
            inSsrGraph: true
        });
        expect(sent).toEqual([]);
    });

    it('ignores node_modules and dist churn', () => {
        for (const file of ['/proj/node_modules/dep/index.js', '/proj/packages/x/dist/index.js']) {
            const { sent } = runHotUpdate({ file, clientModules: [], inSsrGraph: true });
            expect(sent).toEqual([]);
        }
    });

    it('runs once — only the client environment reaches the browser', () => {
        const { sent } = runHotUpdate({
            envName: 'ssr',
            file: '/proj/src/App.tsx',
            clientModules: [],
            inSsrGraph: true
        });
        expect(sent).toEqual([]);
    });

    it('no-ops (does not throw) when the dev server has no ssr environment', () => {
        expect(() =>
            runHotUpdate({ file: '/proj/src/App.tsx', clientModules: [], noSsrEnv: true })
        ).not.toThrow();
        const { sent } = runHotUpdate({ file: '/proj/src/App.tsx', clientModules: [], noSsrEnv: true });
        expect(sent).toEqual([]);
    });

    it('is inert when hmr is disabled', () => {
        const { sent } = runHotUpdate({
            file: '/proj/src/App.tsx',
            clientModules: [],
            inSsrGraph: true,
            pluginOptions: { hmr: false }
        });
        expect(sent).toEqual([]);
    });
});

// ============================================================================
// The dev-time single-copy pin — #487, #655
// ============================================================================

/**
 * In dev the whole `@sigx` family must resolve to ONE physical copy each
 * (#431). From #487 to #655 that was a generated `resolve.alias` map — dead
 * code before #500 (it looked packages up in a way that threw for every one,
 * so the map was always `{}` and nothing asserted on it), then, once real,
 * a string-keyed map that Vite prefix-matched: `@sigx/x/css?url` matched no
 * key for itself, fell through to the bare `@sigx/x` key, and came out as
 * `…/dist/index.js/css?url` (#655). It is now a `resolveId` step on the
 * plugin, and these tests hold it to what the dev server actually does.
 *
 * Two layers. The hook is called directly with a recording `this.resolve`
 * for everything that needs no built dist — what it hands Vite for a given
 * import, and what it stays out of. A real `createServer` (no socket, no dep
 * scan) then asks the client environment's plugin container, which is the
 * path `vite:import-analysis` takes and the path the issue reports;
 * resolutions through it need the pinned file to exist, so those few run
 * only where `pnpm build` has (CI does, before `pnpm test`).
 */

/** The plugin after its serve-mode `config` hook, ready for `resolveId`. */
async function servePlugin(userConfig: any = {}) {
    const plugin: any = sigxPlugin();
    const root = makeProjectRoot();
    const config = await plugin.config({ root, ...userConfig }, { command: 'serve', mode: 'development' });
    return { plugin, config };
}

/**
 * Call the hook the way Vite would, with a `this.resolve` that records the
 * id and options it is handed and pretends to resolve it. Returns what the
 * hook returned plus the recorded call, if any.
 */
async function callResolveId(plugin: any, id: string, importer = '/proj/src/main.ts') {
    const calls: Array<{ id: string; options: any }> = [];
    const ctx = {
        environment: { name: 'client' },
        resolve: async (rid: string, _imp: string | undefined, options: any) => {
            calls.push({ id: rid, options });
            return { id: rid };
        }
    };
    const result = await plugin.resolveId.call(ctx, id, importer, { attributes: {}, isEntry: false });
    return { result, call: calls[0] };
}

/** A dev server with the plugin: no websocket, no watcher, no dep scan. */
const servers: Array<{ close(): Promise<void> }> = [];
async function devServer(userConfig: any = {}) {
    const root = makeProjectRoot();
    fs.mkdirSync(path.join(root, 'src'));
    const importer = path.join(root, 'src', 'main.ts');
    fs.writeFileSync(importer, '', 'utf-8');
    const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, watch: null, hmr: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        ...userConfig,
        plugins: [sigxPlugin()]
    });
    servers.push(server);
    const resolve = (id: string) => server.environments.client.pluginContainer.resolveId(id, importer);
    return { server, resolve };
}

afterAll(async () => {
    for (const server of servers) await server.close();
    servers.length = 0;
});

const SUBPATH = '@sigx/runtime-core/internals';
const BARE = '@sigx/runtime-core';
/** Vite ids are `/`-separated on every platform (#324). */
const builtInternals = normalizePath(fileURLToPath(new URL('../../runtime-core/dist/internals.js', import.meta.url)));
const builtIndex = normalizePath(fileURLToPath(new URL('../../runtime-core/dist/index.js', import.meta.url)));

describe('the dev pin — what the resolveId hook hands Vite (serve, #487)', () => {
    it('pins the core packages — the lookup that used to throw for every one', async () => {
        const { plugin } = await servePlugin();
        for (const pkg of SIGX_CORE_PACKAGES) {
            const { call } = await callResolveId(plugin, pkg);
            expect(call, `pin for ${pkg}`).toBeTruthy();
            // Built dist, never src: `__DEV__` is defined by the package builds
            // only, so a src pin would leave the family referencing an
            // undefined global.
            expect(call.id).not.toMatch(/[/\\]src[/\\]/);
            expect(call.id).toMatch(/[/\\]dist[/\\]/);
            // Existence is a claim about the BUILD, not about this hook, and
            // it only holds after `pnpm build` (#512). Where the dist exists,
            // the check still runs.
            if (fs.existsSync(path.dirname(call.id))) {
                expect(fs.existsSync(call.id)).toBe(true);
            }
        }
    });

    it('pins every exports subpath to its own file, never the bare name\'s', async () => {
        const { plugin } = await servePlugin();
        const { call: internals } = await callResolveId(plugin, '@sigx/runtime-core/internals');
        const { call: bare } = await callResolveId(plugin, '@sigx/runtime-core');
        expect(internals.id).toMatch(/[/\\]internals\.js$/);
        expect(bare.id).toMatch(/[/\\]index\.js$/);
        expect((await callResolveId(plugin, 'sigx/internals')).call.id).toMatch(/[/\\]internals\.js$/);
    });

    it('hands the absolute file to Vite with skipSelf, so it never comes back through the hook', async () => {
        const { plugin } = await servePlugin();
        const { result, call } = await callResolveId(plugin, BARE);
        expect(call.options.skipSelf).toBe(true);
        expect(result).toEqual({ id: call.id });
        // The absolute path itself is not a sigx specifier.
        expect((await callResolveId(plugin, call.id)).call).toBeUndefined();
    });

    it('stays out of everything that is not a pinned specifier', async () => {
        const { plugin } = await servePlugin();
        for (const id of ['./local.ts', '/abs/file.js', 'react', '@other/pkg/sub', '@sigx/not-installed', '@sigx/runtime-core-extra']) {
            const { result, call } = await callResolveId(plugin, id);
            expect(result, id).toBeNull();
            expect(call, id).toBeUndefined();
        }
    });

    it('leaves a subpath with no literal exports entry to Vite when Node cannot resolve it', async () => {
        // The pinned package's own resolver is asked (that is what serves a
        // wildcard export such as `./themes/*` — no workspace package has one
        // to test against, and the lookup is anchored at the plugin's own
        // location, so a fixture in a temp node_modules would be invisible to
        // it); when it has no answer, Vite resolves the import as for any
        // package this plugin does not pin — a loud, accurate error instead
        // of the old `…/index.js/not-exported` mangling.
        const { plugin } = await servePlugin();
        const { result, call } = await callResolveId(plugin, BARE + '/not-exported');
        expect(result).toBeNull();
        expect(call).toBeUndefined();
    });

    it('does nothing in build mode', async () => {
        const plugin: any = sigxPlugin();
        const config = await plugin.config({ root: makeProjectRoot() }, { command: 'build', mode: 'production' });
        expect(config.resolve?.alias).toBeUndefined();
        expect((await callResolveId(plugin, BARE)).result).toBeNull();
    });

    it('writes no resolve.alias — the project\'s own map reaches later plugins unchanged', async () => {
        const userAlias = { 'sigx': '/pinned/sigx.js', '@app': '/proj/src' };
        const userConfig: any = { resolve: { alias: userAlias } };
        const { config } = await servePlugin(userConfig);
        expect(config.resolve?.alias).toBeUndefined();
        // …and after the merge Vite performs it is still the user's object.
        const merged = mergeConfig(userConfig, config);
        expect(merged.resolve.alias).toEqual(userAlias);
    });
});

describe('the dev pin — a real dev server (serve, #655)', () => {
    it.runIf(fs.existsSync(builtInternals))(
        'resolves the bare name, a subpath, and its `?url` / `?raw` / `?worker` / `#…` forms',
        async () => {
            const { resolve } = await devServer();
            expect((await resolve(BARE))?.id).toBe(builtIndex);
            expect((await resolve(SUBPATH))?.id).toBe(builtInternals);
            for (const postfix of ['?url', '?raw', '?worker', '#frag']) {
                const resolved = await resolve(SUBPATH + postfix);
                // `vite:alias`'s `noResolved` marker is what import-analysis
                // turns into "Failed to resolve import … Does the file exist?".
                expect(resolved?.meta?.['vite:alias']?.noResolved, SUBPATH + postfix).toBeFalsy();
                expect(resolved?.id, SUBPATH + postfix).toBe(builtInternals + postfix);
            }
        }
    );

    // The user's alias must win in EVERY form Vite accepts. None of these
    // needs a built dist: the user's target does not exist, so Vite hands
    // back the rewritten id itself — which is the assertion.
    const userAliasWins: Array<[string, any, string, string]> = [
        ['a scope prefix', { '@sigx': '/fork' }, '@sigx/reactivity', '/fork/reactivity'],
        ['a trailing-slash pair', { '@sigx/reactivity/': '/pinned/' }, '@sigx/reactivity/internals', '/pinned/internals'],
        ['a bare exact key', { '@sigx/reactivity': '/pinned/r.js' }, '@sigx/reactivity', '/pinned/r.js'],
        ['an array RegExp entry', [{ find: /^@sigx\/reactivity/, replacement: '/pinned/r' }], '@sigx/reactivity/internals', '/pinned/r/internals'],
        // The workaround people wrote for #655 itself.
        ['a key on the queried form', { [SUBPATH + '?url']: '/my/theme.css?url' }, SUBPATH + '?url', '/my/theme.css?url'],
    ];
    for (const [form, alias, id, target] of userAliasWins) {
        it(`a user alias wins by Vite's own ordering: ${form}`, async () => {
            const { resolve } = await devServer({ resolve: { alias } });
            expect((await resolve(id))?.id).toBe(target);
        });
    }

    it.runIf(fs.existsSync(builtInternals))(
        'a user alias on one package leaves the others pinned',
        async () => {
            const { resolve } = await devServer({ resolve: { alias: { '@sigx/reactivity': '/pinned/r.js' } } });
            expect((await resolve('@sigx/reactivity'))?.id).toBe('/pinned/r.js');
            expect((await resolve(SUBPATH + '?url'))?.id).toBe(builtInternals + '?url');
        }
    );
});
