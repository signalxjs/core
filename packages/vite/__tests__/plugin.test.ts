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

/** One `resolve.alias` entry, either form Vite accepts. */
interface AliasEntry {
    find: string | RegExp;
    replacement: string;
}

/** The alias list as Vite normalizes it: an object map becomes `{ find, replacement }` entries. */
function aliasEntries(alias: unknown): AliasEntry[] {
    if (Array.isArray(alias)) return alias as AliasEntry[];
    return Object.entries((alias ?? {}) as Record<string, string>)
        .map(([find, replacement]) => ({ find, replacement }));
}

/**
 * What Vite's alias plugin DOES with the map — its matcher, verbatim: a string
 * `find` matches the importee exactly or as a `/`-delimited prefix, a RegExp
 * `find` by `test`; the first hit is applied with
 * `importee.replace(find, replacement)`. Asserting on this rather than on the
 * map's shape is what lets a test say "this import resolves to that file".
 * `undefined` = no entry matched, Vite's own resolver takes over.
 */
function applyAlias(alias: unknown, importee: string): string | undefined {
    const hit = aliasEntries(alias).find(({ find }) =>
        find instanceof RegExp
            ? find.test(importee)
            : importee === find || importee.startsWith(find + '/'));
    return hit && importee.replace(hit.find, hit.replacement);
}

/** The specifier an entry was generated for (a RegExp find, unescaped and unanchored). */
function specifierOf({ find }: AliasEntry): string {
    return find instanceof RegExp
        ? find.source.replace(/^\^/, '').replace(/\(\?=.*$/, '').replace(/\\(.)/g, '$1')
        : find;
}

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
// resolve.alias (dev) — #487
// ============================================================================

/**
 * The dev alias map is what keeps the whole `@sigx` family resolving to ONE
 * physical copy each. It was dead code from the day it was written: it looked
 * packages up with `require.resolve('<pkg>/package.json')`, which no `@sigx`
 * package exports, so every lookup threw and the map was always `{}`. Nothing
 * asserted on it — `optimizeDeps.exclude` and `ssr.noExternal` were covered,
 * `resolve.alias` was not — so the README documented behaviour that never ran
 * and apps carried hand-written maps instead.
 *
 * These tests exist mostly to make that impossible again: the first one fails
 * on the whole class of "the map came out empty".
 */
describe('config hook — resolve.alias (serve, #487)', () => {
    it('resolves the core packages — the lookup that used to throw for every one', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook({ root }, 'serve');

        for (const pkg of SIGX_CORE_PACKAGES) {
            const file = applyAlias(config.resolve.alias, pkg);
            expect(file, `alias for ${pkg}`).toBeTruthy();
            // Built dist, never src: `__DEV__` is defined by the package builds
            // only, so a src alias would leave the family referencing an
            // undefined global.
            expect(file).not.toMatch(/[/\\]src[/\\]/);
            expect(file).toMatch(/[/\\]dist[/\\]/);
            // Existence is a claim about the BUILD, not about this config hook,
            // and it only holds after `pnpm build` — which CI runs before
            // `pnpm test` (ci.yml), but a fresh clone does not (#512). Asserting
            // it unconditionally made `pnpm test` fail on any tree that had
            // never built, which reads as "the alias map is broken" and is not.
            // Where the dist exists, the check still runs.
            if (fs.existsSync(path.dirname(file!))) {
                expect(fs.existsSync(file!)).toBe(true);
            }
        }
    });

    it('emits an entry per exports subpath, subpaths ordered before the bare name', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook({ root }, 'serve');
        const keys = aliasEntries(config.resolve.alias).map(specifierOf);

        // Subpath entries exist at all (the reason a hand map grows per package).
        expect(keys).toContain('@sigx/runtime-core/internals');
        expect(keys).toContain('sigx/internals');
        expect(applyAlias(config.resolve.alias, '@sigx/runtime-core/internals'))
            .not.toBe(applyAlias(config.resolve.alias, '@sigx/runtime-core'));

        // Vite matches a string find as `importee === find ||
        // importee.startsWith(find + '/')` and then prefix-REPLACES, so a bare
        // key ahead of its own subpath would rewrite
        // `@sigx/runtime-core/internals` to `…/index.js/internals`. The
        // anchored RegExp finds (#655) make the order moot for Vite; it is
        // kept because it keeps the emitted list readable.
        for (const key of keys) {
            const bare = keys.indexOf(key.split('/').slice(0, key.startsWith('@') ? 2 : 1).join('/'));
            const self = keys.indexOf(key);
            if (bare !== -1 && bare !== self) {
                expect(bare, `${key} must be ordered before its bare specifier`).toBeGreaterThan(self);
            }
        }
    });

    it('leaves a package alone when the project already aliases any of its specifiers', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook(
            { root, resolve: { alias: { 'sigx': '/pinned/sigx.js' } } },
            'serve'
        );

        // All of a package's entries or none: a user's bare `sigx` merged ahead
        // of our `sigx/internals` would prefix-match first and break it.
        expect(applyAlias(config.resolve.alias, 'sigx')).toBeUndefined();
        expect(applyAlias(config.resolve.alias, 'sigx/internals')).toBeUndefined();
        // Other packages are unaffected.
        expect(applyAlias(config.resolve.alias, '@sigx/reactivity')).toBeTruthy();
    });

    it('honours the ARRAY alias form, including a RegExp find', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook(
            { root, resolve: { alias: [{ find: /^@sigx\/reactivity/, replacement: '/pinned/reactivity.js' }] } },
            'serve'
        );

        // A stringified RegExp key never equals a specifier, so a naive
        // comparison would generate entries for a package the project is
        // deliberately routing elsewhere.
        expect(applyAlias(config.resolve.alias, '@sigx/reactivity')).toBeUndefined();
        expect(applyAlias(config.resolve.alias, '@sigx/reactivity/internals')).toBeUndefined();
        expect(applyAlias(config.resolve.alias, 'sigx')).toBeTruthy();
    });

    it('honours an exact string find in the array form', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook(
            { root, resolve: { alias: [{ find: 'sigx', replacement: '/pinned/sigx.js' }] } },
            'serve'
        );

        expect(applyAlias(config.resolve.alias, 'sigx')).toBeUndefined();
        expect(applyAlias(config.resolve.alias, 'sigx/internals')).toBeUndefined();
        expect(applyAlias(config.resolve.alias, '@sigx/reactivity')).toBeTruthy();
    });

    it('the user entry survives the merge Vite performs', async () => {
        const root = makeProjectRoot();
        const userConfig: any = { root, resolve: { alias: { 'sigx': '/pinned/sigx.js' } } };
        const merged = mergeConfig(userConfig, await runConfigHook(userConfig, 'serve'));

        expect(applyAlias(merged.resolve.alias, 'sigx')).toBe('/pinned/sigx.js');
        // …and ours still apply alongside it.
        expect(applyAlias(merged.resolve.alias, '@sigx/reactivity')).toMatch(/[/\\]dist[/\\]/);
    });

    it('adds no aliases in build mode', async () => {
        const root = makeProjectRoot();
        const config = await runConfigHook({ root }, 'build');
        expect(config.resolve?.alias).toBeUndefined();
    });
});

// ============================================================================
// resolve.alias — query-suffixed subpath imports (dev) — #655
// ============================================================================

/**
 * `import css from '@sigx/zero-basic/css?url'` failed to resolve in the dev
 * server from the release that made the alias map real (#500, 0.14.0). The
 * entries were string keys, and Vite matches a string `find` as
 * `importee === find || importee.startsWith(find + '/')`: `…/css?url` is
 * neither for the `…/css` key (`?` is not `/`), so it fell through to the
 * bare `@sigx/zero-basic` key, prefix-matched THAT, and came out as
 * `…/dist/index.js/css?url` — "Failed to resolve import". Every `?url` /
 * `?raw` / `?inline` / `?worker` import of a subpath export was affected.
 *
 * The entries are now anchored RegExp finds that stop at the end of the
 * specifier or at `?`, so the query rides along the replacement. These tests
 * apply Vite's matcher to the returned map; the last one drives a real dev
 * server and asks its plugin container, which is the path the issue reports.
 */
describe('config hook — resolve.alias with a query suffix (serve, #655)', () => {
    const SUBPATH = '@sigx/runtime-core/internals';
    const BARE = '@sigx/runtime-core';

    it('carries `?url` and `?raw` across the rewrite of a subpath export', async () => {
        const root = makeProjectRoot();
        const { alias } = (await runConfigHook({ root }, 'serve')).resolve;
        const file = applyAlias(alias, SUBPATH);
        expect(file).toMatch(/[/\\]internals\.js$/);

        for (const query of ['?url', '?raw', '?inline', '?worker']) {
            const out = applyAlias(alias, SUBPATH + query);
            expect(out, SUBPATH + query).toBe(file + query);
            // The failure mode, by name: the bare entry's prefix rewrite.
            expect(out).not.toMatch(/index\.js[/\\]/);
        }
    });

    it('carries a query across the rewrite of the bare package name', async () => {
        const root = makeProjectRoot();
        const { alias } = (await runConfigHook({ root }, 'serve')).resolve;
        expect(applyAlias(alias, BARE + '?url')).toBe(applyAlias(alias, BARE) + '?url');
    });

    it('still resolves the bare name and a plain subpath as before', async () => {
        const root = makeProjectRoot();
        const { alias } = (await runConfigHook({ root }, 'serve')).resolve;
        expect(applyAlias(alias, BARE)).toMatch(/[/\\]dist[/\\]index\.js$/);
        expect(applyAlias(alias, SUBPATH)).toMatch(/[/\\]dist[/\\]internals\.js$/);
    });

    it('leaves a subpath with no exports entry to Vite instead of mangling it', async () => {
        const root = makeProjectRoot();
        const { alias } = (await runConfigHook({ root }, 'serve')).resolve;
        // The bare key used to prefix-rewrite this to `…/index.js/not-exported`;
        // with no entry matching, Vite's own resolver reports it against the
        // package's real `exports` map.
        expect(applyAlias(alias, BARE + '/not-exported')).toBeUndefined();
        // Anchored: a longer specifier is not a prefix match of a shorter one.
        expect(applyAlias(alias, SUBPATH + '-extra')).toBeUndefined();
    });

    // The end-to-end shape of the report: a Vite dev server with the plugin
    // installed, asked to resolve the import the way `vite:import-analysis`
    // does. Needs the built dist (Vite's resolver checks the file exists), so
    // it runs where `pnpm build` has run — CI does, before `pnpm test`.
    const builtInternals = fileURLToPath(
        new URL('../../runtime-core/dist/internals.js', import.meta.url)
    );
    it.runIf(fs.existsSync(builtInternals))(
        'a real dev server resolves `<subpath>?url` to the subpath file, query intact',
        async () => {
            const root = makeProjectRoot();
            fs.mkdirSync(path.join(root, 'src'));
            const importer = path.join(root, 'src', 'main.ts');
            fs.writeFileSync(importer, '', 'utf-8');
            const server = await createServer({
                root,
                configFile: false,
                logLevel: 'silent',
                server: { middlewareMode: true, watch: null },
                optimizeDeps: { noDiscovery: true, include: [] },
                plugins: [sigxPlugin()]
            });
            try {
                const container = (server.environments.client as any).pluginContainer;
                for (const query of ['?url', '?raw']) {
                    const resolved = await container.resolveId(SUBPATH + query, importer);
                    // `vite:alias`'s `noResolved` marker is what import-analysis
                    // turns into "Failed to resolve import … Does the file exist?".
                    expect(resolved?.meta?.['vite:alias']?.noResolved, SUBPATH + query).toBeFalsy();
                    // Vite ids are `/`-separated on every platform (#324).
                    expect(resolved?.id).toBe(normalizePath(builtInternals) + query);
                }
                const plain = await container.resolveId(SUBPATH, importer);
                expect(plain?.id).toBe(normalizePath(builtInternals));
            } finally {
                await server.close();
            }
        }
    );
});
