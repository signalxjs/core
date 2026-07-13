// Vite plugin for sigx with HMR support
import type { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as net from 'net';
import path from 'path';

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
     * free port automatically. Explicit `server.hmr` settings in the Vite
     * config always take precedence over this option.
     */
    hmrPort?: number;
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
 * or undefined to leave the user's config alone.
 */
async function resolveHmrPortOverride(
    userConfig: UserConfig,
    hmrPort: number | undefined
): Promise<UserConfig['server'] | undefined> {
    const userHmr = userConfig.server?.hmr;
    // HMR disabled, or the user already pinned a port / supplied a server —
    // their config wins.
    if (userHmr === false) return undefined;
    if (typeof userHmr === 'object' && (userHmr.port != null || userHmr.server)) {
        return undefined;
    }
    if (hmrPort != null) {
        return { hmr: { port: hmrPort } };
    }
    // Without middleware mode the websocket shares the HTTP server's port —
    // nothing to fix. In middleware mode Vite would default to 24678, which
    // collides across concurrent dev servers; pick a free port instead.
    if (!userConfig.server?.middlewareMode) return undefined;
    return { hmr: { port: await getFreePort() } };
}

// ============================================================================
// Vite Plugin
// ============================================================================

export function sigxPlugin(options: SigxPluginOptions = {}): Plugin {
    const {
        hmr = true,
        hmrPort,
    } = options;

    let config: ResolvedConfig;

    return {
        name: 'sigx',
        enforce: 'pre',

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
                    ssr: {
                        noExternal: SIGX_SSR_NO_EXTERNAL
                    },
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
                };
            }
        },

        configResolved(resolvedConfig) {
            config = resolvedConfig;
        },

        transform(code, id) {
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

// Default export for convenience
export default sigxPlugin;
