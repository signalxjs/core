// Vite plugin for sigx with HMR support
import type { Plugin, ResolvedConfig, UserConfig, ViteBuilder } from 'vite';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as net from 'net';
import path from 'path';
import { adapterSsrEnvironment, nodeAdapter, type SigxAdapter } from './adapter.js';
import {
    APP_VIRTUAL_ID,
    APP_RESOLVED_ID,
    APP_FILE,
    MANIFESTS_VIRTUAL_ID,
    MANIFESTS_RESOLVED_ID,
    generateAppModuleCode,
    generateServeError,
    generateManifestsModuleCode,
    generateManifestsServeCode
} from './app-module.js';
import {
    SSR_NODE_VIRTUAL_ID,
    SSR_NODE_RESOLVED_ID,
    generateSSRNodeShimCode
} from './ssr.js';

// ============================================================================
// Types
// ============================================================================

interface SigxPluginOptions {
    /**
     * Enable HMR support
     * @default true
     */
    hmr?: boolean;

    /**
     * Port for Vite's HMR websocket.
     *
     * Only relevant when the dev server cannot piggyback the websocket on the
     * HTTP server itself (middleware mode — the standard sigx SSR setup).
     * There Vite defaults to port 24678, which collides as soon as two dev
     * servers run on one machine: the browser connects to the *other*
     * server's websocket, gets a 400 token mismatch, and HMR breaks.
     *
     * When unset and the server runs in middleware mode, the plugin picks a
     * free port automatically. A user-pinned `server.ws.port` or
     * `server.ws.server` — or `ws: false`, or the deprecated `server.hmr`
     * spellings of the same — always takes precedence over this option;
     * other `server.ws` settings (protocol, host, …) merge with the picked
     * port.
     */
    hmrPort?: number;

    /**
     * SSR mode (rfc-ssr-platform §3.1): orchestrate the client + server
     * builds in ONE `vite build` via the environments/builder API — the
     * client environment emits its manifest (`.vite/manifest.json`, feeding
     * `collectAssets` → `DocumentOptions.assets`) into `clientOutDir`, and
     * the ssr environment builds `entry` into `serverOutDir`. Replaces the
     * hand-run `vite build && vite build --ssr …` double invocation.
     */
    ssr?: {
        /** The SSR entry module, e.g. 'src/entry-server.tsx'. */
        entry: string;
        /** Client build output. Default: 'dist/client'. */
        clientOutDir?: string;
        /** Server build output. Default: 'dist/server'. */
        serverOutDir?: string;
        /**
         * Deployment adapter (rfc-deploy §3.1): shapes the ssr environment's
         * build ('external' vs fully 'bundled', platform conditions) and may
         * generate platform output after both environments have written.
         * Default: `nodeAdapter()` — today's externalized Node output,
         * byte-identical.
         */
        adapter?: SigxAdapter;
    };
}

// ============================================================================
// Resolve package source paths for aliasing
// ============================================================================

function resolvePackageSrc(packageName: string, entry = 'index.ts'): string | null {
    try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve(`${packageName}/package.json`);
        const pkgDir = path.dirname(pkgPath);
        return path.join(pkgDir, 'src', entry);
    } catch {
        return null;
    }
}

// ============================================================================
// Single-module-instance configuration
// ============================================================================

/**
 * The core runtime tier. These are always kept out of optimizeDeps
 * pre-bundling (and unified on the SSR side), whether or not the consumer's
 * package.json declares them directly.
 */
const SIGX_CORE_PACKAGES = [
    'sigx',
    '@sigx/reactivity',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/server-renderer',
];

/**
 * SSR externalization: keep the WHOLE @sigx family in the SSR module graph.
 * If only some packages run through Vite's module runner while others load
 * via Node's resolver, each graph holds its own `@sigx/reactivity` instance
 * and signals created on one side never trigger effects tracked on the other.
 */
const SIGX_SSR_NO_EXTERNAL: (string | RegExp)[] = ['sigx', /^@sigx\//];

/**
 * Compute the optimizeDeps.exclude list: the core packages (floor) plus every
 * `@sigx/*` package the consumer project declares (store, router, daisyui, …).
 *
 * `optimizeDeps.exclude` takes exact package names — no patterns — so the
 * companion packages have to be enumerated from the project's package.json.
 * Without this, esbuild pre-bundles them into `.vite/deps` chunks that carry
 * their own copy of `@sigx/reactivity`, splitting the module graph in two:
 * signals written by store/router code become invisible to the renderer's
 * effects (silently dead UI).
 */
function collectSigxOptimizeDepsExcludes(root: string): string[] {
    const excludes = new Set<string>(SIGX_CORE_PACKAGES);
    try {
        const pkgJson = JSON.parse(
            fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
        ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        for (const deps of [pkgJson.dependencies, pkgJson.devDependencies]) {
            if (!deps) continue;
            for (const name of Object.keys(deps)) {
                if (name === 'sigx' || name.startsWith('@sigx/')) {
                    excludes.add(name);
                }
            }
        }
    } catch {
        // No readable package.json at the project root — fall back to the core floor.
    }
    return [...excludes];
}

/** Ask the OS for a currently-free TCP port. */
function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Decide whether to override Vite's HMR websocket port (see
 * `SigxPluginOptions.hmrPort`). Returns a partial `server` config to merge,
 * or undefined to leave the user's config alone. Emits `server.ws` (Vite 8
 * deprecated `server.hmr.*` in its favor) while still deferring to settings
 * a user supplied under either name.
 */
async function resolveHmrPortOverride(
    userConfig: UserConfig,
    hmrPort: number | undefined
): Promise<UserConfig['server'] | undefined> {
    // The user's websocket config wins under EITHER spelling — `server.ws`
    // (current) or the deprecated `server.hmr` alias Vite still honors —
    // and both are inspected (not `??`-chained), so a port pinned under one
    // spelling defers even when the other spelling holds unrelated options.
    const userWs = userConfig.server?.ws;
    const userHmr = userConfig.server?.hmr;
    if (userWs === false || userHmr === false) return undefined;
    const pinned = (value: typeof userWs | typeof userHmr): boolean =>
        typeof value === 'object' && value != null && (value.port != null || !!value.server);
    if (pinned(userWs) || pinned(userHmr)) return undefined;
    if (hmrPort != null) {
        return { ws: { port: hmrPort } };
    }
    // Without middleware mode the websocket shares the HTTP server's port —
    // nothing to fix. In middleware mode Vite would default to 24678, which
    // collides across concurrent dev servers; pick a free port instead.
    if (!userConfig.server?.middlewareMode) return undefined;
    return { ws: { port: await getFreePort() } };
}

// ============================================================================
// Vite Plugin
// ============================================================================

export function sigxPlugin(options: SigxPluginOptions = {}): Plugin {
    const {
        hmr = true,
        hmrPort,
        ssr,
    } = options;

    // The adapter shapes the ssr environment (rfc-deploy §3.1). The default
    // is today's externalized Node output; only an EXPLICIT adapter can
    // conflict with sigxServer({ role: 'client' }).
    const adapter = ssr?.adapter ?? nodeAdapter();
    const adapterExplicit = ssr?.adapter != null;

    let config: ResolvedConfig;
    let isServe = false;
    /** Absolute client outDir — where virtual:sigx-app reads at build time. */
    let clientDir = '';

    return {
        name: 'sigx',
        enforce: 'pre',

        // Cross-plugin introspection seam (mirror of sigx:server's
        // api.role): sigx:server reads adapter.serverBuild to skip the
        // registry-chunk emission in bundled builds, where the virtual
        // inlines into the one worker bundle and the chunk has no consumer.
        api: ssr ? { adapter: { name: adapter.name, serverBuild: adapter.serverBuild } } : {},

        async configureServer(server) {
            // Platform-binding proxies in dev (rfc-deploy §4.6) — adapters
            // change builds, not dev; this hook is the one exception.
            if (ssr?.adapter?.dev) {
                await ssr.adapter.dev(server);
            }
            // Workspace-dist modules must never be immutable in dev (#272):
            // Vite serves `/@fs/**?v=<hash>` with a year-long immutable
            // Cache-Control, and the hash does NOT change when a linked
            // package's dist/ is rebuilt — real browsers end up on a MIXED
            // module graph (fresh top-levels importing stale internals).
            // Downgrade those responses to no-cache; ETag revalidation keeps
            // repeat loads as cheap 304s.
            const isWorkspaceDist = (url: string | undefined): boolean => {
                if (!url) return false;
                const path = url.split('?')[0];
                // Vite's /@fs/ is a URL PREFIX, not a substring.
                return path.startsWith('/@fs/') && path.includes('/dist/');
            };
            server.middlewares.use((req, res, next) => {
                if (isWorkspaceDist(req.url)) {
                    const setHeader = res.setHeader.bind(res);
                    // Preserve the original return value (chainable) and
                    // pass non-matching values through untouched.
                    res.setHeader = ((name, value) =>
                        setHeader(name, typeof name === 'string' && name.toLowerCase() === 'cache-control' ? 'no-cache' : value)
                    ) as typeof res.setHeader;
                }
                next();
            });
        },

        async config(userConfig, { command }) {
            // In dev mode, alias @sigx/* packages to their source files
            // This ensures a single reactivity instance across all packages
            if (command === 'serve') {
                const sigxSrc = resolvePackageSrc('sigx');
                const reactivitySrc = resolvePackageSrc('@sigx/reactivity');
                const runtimeCoreSrc = resolvePackageSrc('@sigx/runtime-core');
                const runtimeDomSrc = resolvePackageSrc('@sigx/runtime-dom');
                const serverRendererSrc = resolvePackageSrc('@sigx/server-renderer');

                const alias: Record<string, string> = {};
                if (sigxSrc) {
                    alias['sigx/internals'] = resolvePackageSrc('sigx', 'internals.ts')!;
                    alias['sigx/jsx-runtime'] = sigxSrc;
                    alias['sigx/jsx-dev-runtime'] = sigxSrc;
                    alias['sigx'] = sigxSrc;
                }
                if (reactivitySrc) {
                    alias['@sigx/reactivity/internals'] = resolvePackageSrc('@sigx/reactivity', 'internals.ts')!;
                    alias['@sigx/reactivity'] = reactivitySrc;
                }
                if (runtimeCoreSrc) {
                    alias['@sigx/runtime-core/internals'] = resolvePackageSrc('@sigx/runtime-core', 'internals.ts')!;
                    alias['@sigx/runtime-core'] = runtimeCoreSrc;
                }
                if (runtimeDomSrc) {
                    alias['@sigx/runtime-dom/internals'] = resolvePackageSrc('@sigx/runtime-dom', 'internals.ts')!;
                    alias['@sigx/runtime-dom'] = runtimeDomSrc;
                }
                if (serverRendererSrc) alias['@sigx/server-renderer'] = serverRendererSrc;

                const root = userConfig.root
                    ? path.resolve(userConfig.root)
                    : process.cwd();
                const serverOverride = await resolveHmrPortOverride(userConfig, hmrPort);

                return {
                    resolve: {
                        alias
                    },
                    optimizeDeps: {
                        // Exclude ALL @sigx packages from pre-bundling — the
                        // core tier plus every @sigx/* dependency the project
                        // declares — so the whole family resolves through the
                        // source module graph and shares one reactivity
                        // instance. Vite merges this with (not over) any
                        // user-specified excludes.
                        exclude: collectSigxOptimizeDepsExcludes(root)
                    },
                    ssr: {
                        noExternal: SIGX_SSR_NO_EXTERNAL
                    },
                    ...(serverOverride && { server: serverOverride })
                };
            }

            // In build mode, force the entire sigx runtime into a single shared
            // chunk and dedupe across the dep graph. Without this, Vite/Rolldown
            // happily inlines `@sigx/reactivity` into multiple chunks (e.g. once
            // alongside `sigx` and once alongside `@sigx/runtime-core`). Each
            // copy ships its own module-scoped `activeEffect`/dep WeakMap, so a
            // signal created via one copy never triggers effects tracked by the
            // other — observably, signal mutations from `onMounted`, observers,
            // `setTimeout`, and event handlers silently fail to re-render after
            // hydration. Pinning everything to a single `sigx` chunk plus
            // `resolve.dedupe` keeps reactivity a single module instance.
            if (command === 'build') {
                return {
                    resolve: {
                        dedupe: [...SIGX_CORE_PACKAGES],
                    },
                    // In the ORCHESTRATED ssr mode the server bundle must
                    // EXTERNALIZE its dependencies: the production request
                    // handler (@sigx/server-renderer/node) loads from
                    // node_modules, so a bundled copy of the runtime inside
                    // entry-server.js would carry its own DI token identities
                    // and never see the app's provides. Standalone
                    // `vite build --ssr` flows (self-contained bundles) keep
                    // the classic noExternal hygiene.
                    ...(ssr
                        ? {}
                        : { ssr: { noExternal: SIGX_SSR_NO_EXTERNAL } }),
                    build: {
                        rollupOptions: {
                            output: {
                                manualChunks(id: string) {
                                    if (/[\\/]node_modules[\\/](sigx|@sigx[\\/](?:reactivity|runtime-core|runtime-dom|server-renderer))[\\/]/.test(id)) {
                                        return 'sigx';
                                    }
                                },
                            },
                        },
                    },
                    // SSR mode: one `vite build` builds both environments —
                    // client (with its asset manifest, feeding collectAssets)
                    // and server (the SSR entry, shaped by the adapter:
                    // 'external' resolves the whole @sigx family from
                    // node_modules, sharing one module graph with the
                    // production request handler; 'bundled' is total — one
                    // bundle IS one module graph, handler included — so both
                    // ends of the binary are safe for DI-token identity, and
                    // the partially-external middle ground stays
                    // unrepresentable).
                    ...(ssr && {
                        builder: {},
                        environments: {
                            client: {
                                build: {
                                    manifest: true,
                                    outDir: ssr.clientOutDir ?? 'dist/client'
                                }
                            },
                            ssr: adapterSsrEnvironment(
                                adapter,
                                ssr.serverOutDir ?? 'dist/server',
                                adapter.entry ?? ssr.entry
                            )
                        }
                    })
                };
            }
        },

        configResolved(resolvedConfig) {
            config = resolvedConfig;
            isServe = resolvedConfig.command === 'serve';
            clientDir = path.resolve(
                resolvedConfig.root,
                resolvedConfig.environments?.client?.build?.outDir ??
                    ssr?.clientOutDir ??
                    'dist/client'
            );

            // rfc-deploy §3.3: role 'client' describes a build with NO server
            // in it (every server module stubbed, no registry emitted), so an
            // adapter — which shapes the server build — cannot apply. The
            // seam (`api: { role, … }`) landed with role; the error lands
            // here, with adapter.
            if (ssr && adapterExplicit) {
                const serverPlugin = resolvedConfig.plugins.find((p) => p.name === 'sigx:server');
                const role = (serverPlugin?.api as { role?: string } | undefined)?.role;
                if (role === 'client') {
                    throw new Error(
                        `[sigx] ssr.adapter ('${adapter.name}') cannot be combined with ` +
                        `sigxServer({ role: 'client' }): role 'client' declares this whole build a ` +
                        `remote-server client - every server function is stubbed and no registry is ` +
                        `emitted - so there is no server for an adapter to shape. Drop ssr.adapter, ` +
                        `or build the deployed server with role 'auto'.`
                    );
                }
            }
        },

        resolveId(id, importer) {
            if (id === SSR_NODE_VIRTUAL_ID) return SSR_NODE_RESOLVED_ID;
            if (id === MANIFESTS_VIRTUAL_ID) return MANIFESTS_RESOLVED_ID;
            if (id !== APP_VIRTUAL_ID) return;
            // External builds materialize the module as dist/server/sigx-app.js
            // (emitFile below). App imports of the virtual resolve to that
            // emitted sibling instead of the module itself — Rolldown would
            // otherwise inline a SECOND copy of the template into the entry
            // chunk (duplication verified empirically; rfc-deploy §7 flagged
            // it). Bundled builds inline the virtual — one self-contained
            // file IS the deliverable — so no chunk and no indirection.
            if (
                !isServe &&
                ssr &&
                adapter.serverBuild === 'external' &&
                importer &&
                this.environment?.name !== 'client'
            ) {
                return { id: './' + APP_FILE, external: true };
            }
            return APP_RESOLVED_ID;
        },

        load(id) {
            // The dev handler's renderer, behind an import so the project's
            // external/noExternal decision reaches it (#425 — see app-module).
            if (id === SSR_NODE_RESOLVED_ID) return generateSSRNodeShimCode();
            if (id === MANIFESTS_RESOLVED_ID) {
                // Dev packs are manifest-less by design (QRLs/chunks resolve
                // through the virtual registries) — undefineds are correct.
                if (isServe) return generateManifestsServeCode();
                if (this.environment?.name === 'client') {
                    this.warn(
                        'virtual:sigx-manifests is a server concern - client imports resolve to ' +
                        'undefined manifests.'
                    );
                    return generateManifestsServeCode();
                }
                try {
                    return generateManifestsModuleCode(clientDir);
                } catch (err) {
                    this.error(err instanceof Error ? err.message : String(err));
                }
                return;
            }
            if (id !== APP_RESOLVED_ID) return;
            // Dev has no manifests and already solves template/assets live.
            if (isServe) return generateServeError();
            if (this.environment?.name === 'client') {
                this.error(
                    `virtual:sigx-app is server-only - it inlines the CLIENT build's artifacts ` +
                    `for the server render path and must not be imported by client code.`
                );
            }
            try {
                return generateAppModuleCode(clientDir, config.base);
            } catch (err) {
                this.error(err instanceof Error ? err.message : String(err));
            }
        },

        buildStart() {
            // Materialize dist/server/sigx-app.js for the EXTERNAL build (the
            // registry-chunk emitFile pattern): a Node server.mjs collapses
            // from four readFiles to one import, and entry imports of the
            // virtual resolve to this emitted sibling (see resolveId).
            // Bundled builds inline the virtual instead — no separate chunk.
            if (isServe || !ssr || adapter.serverBuild !== 'external') return;
            if (this.environment?.name === 'client') return;
            this.emitFile({ type: 'chunk', id: APP_VIRTUAL_ID, fileName: APP_FILE });
        },

        // Explicit build ordering (rfc-deploy §3.1): the ssr environment's
        // virtual:sigx-app inlines CLIENT artifacts, so client must write
        // first; adapter.generate sees both output trees last. Any further
        // user-defined environments build after the pair (a user-supplied
        // config-level builder.buildApp still runs after this hook and owns
        // whatever this left unbuilt).
        ...(ssr && {
            buildApp: async (builder: ViteBuilder) => {
                const buildLogger = {
                    info: (msg: string) => builder.config.logger.info(msg),
                    warn: (msg: string) => builder.config.logger.warn(msg)
                };
                // Scaffold-iff-absent inputs first (platform entry) — the
                // one moment an adapter may write into src/ (PR #322: "then
                // never touch").
                if (adapter.setup) {
                    await adapter.setup({
                        root: builder.config.root,
                        ssrEntry: ssr.entry,
                        logger: buildLogger
                    });
                }
                // A missing platform entry now fails with the contract named
                // instead of rolldown's raw unresolved-input error.
                if (adapter.entry) {
                    const entryFile = path.resolve(builder.config.root, adapter.entry);
                    if (!fs.existsSync(entryFile)) {
                        throw new Error(
                            `[sigx] adapter '${adapter.name}': platform entry '${adapter.entry}' ` +
                            `does not exist. ` +
                            (adapter.setup
                                ? `This adapter scaffolds it on first build (setup hook) - if you ` +
                                  `deleted it, restore it or let the next build scaffold a fresh one.`
                                : `Create it (the adapter declares no setup hook, so nothing ` +
                                  `scaffolds it automatically).`)
                        );
                    }
                }
                for (const name of ['client', 'ssr']) {
                    const env = builder.environments[name];
                    if (env && !env.isBuilt) await builder.build(env);
                }
                for (const env of Object.values(builder.environments)) {
                    if (!env.isBuilt) await builder.build(env);
                }
                if (adapter.generate) {
                    const root = builder.config.root;
                    await adapter.generate({
                        root,
                        clientOutDir: path.resolve(
                            root,
                            builder.config.environments.client?.build?.outDir ??
                                ssr.clientOutDir ??
                                'dist/client'
                        ),
                        serverOutDir: path.resolve(
                            root,
                            builder.config.environments.ssr?.build?.outDir ??
                                ssr.serverOutDir ??
                                'dist/server'
                        ),
                        ssrInput: path.resolve(root, adapter.entry ?? ssr.entry),
                        logger: buildLogger
                    });
                }
            }
        }),

        transform(code, id, transformOptions) {
            // HMR is a browser concern: never inject into SSR transforms —
            // ssrLoadModule'd component modules previously got the wrapper
            // (and its registry side effects) on the server render path.
            if (transformOptions?.ssr) {
                return null;
            }

            // Only process TypeScript/TSX source files (not pre-built JS)
            if (!/\.tsx?$/.test(id) && !id.endsWith('.jsx')) {
                return null;
            }

            // Skip node_modules and dist folders
            if (id.includes('node_modules') || id.includes('/dist/') || id.includes('\\dist\\')) {
                return null;
            }

            // Check if this file contains component
            const hasComponent = /component\s*[<(]/.test(code);

            // Inject HMR code in dev mode for files with components
            if (hmr && config.command === 'serve' && hasComponent) {
                // Create a module ID for HMR tracking
                const moduleId = id.replace(/\\/g, '/');

                // Inject HMR runtime import and module registration at the top
                const hmrImport = `import { registerHMRModule } from '@sigx/vite/hmr';\nregisterHMRModule('${moduleId}');\n`;

                // Add HMR accept handler at the bottom
                const hmrCode = `
if (import.meta.hot) {
    import.meta.hot.accept();
}
`;
                return {
                    code: hmrImport + code + hmrCode,
                    map: null
                };
            }

            return null;
        }
    };
}

// ============================================================================
// HMR Runtime Plugin (for browser)
// ============================================================================

// Re-export the HMR runtime functions for manual use if needed
export { installHMRPlugin, registerHMRModule } from './hmr.js';

// Deployment build seam (rfc-deploy §3)
export { nodeAdapter } from './adapter.js';
export type { SigxAdapter, AdapterGenerateContext, AdapterSetupContext } from './adapter.js';

// Default export for convenience
export default sigxPlugin;
