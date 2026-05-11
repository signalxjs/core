// Vite plugin for sigx with HMR support
import type { Plugin, ViteDevServer, ResolvedConfig, UserConfig } from 'vite';
import { createRequire } from 'module';
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
// Vite Plugin
// ============================================================================

export function sigxPlugin(options: SigxPluginOptions = {}): Plugin {
    const {
        hmr = true,
    } = options;

    let config: ResolvedConfig;

    return {
        name: 'sigx',
        enforce: 'pre',

        config(userConfig, { command }) {
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

                return {
                    resolve: {
                        alias
                    },
                    optimizeDeps: {
                        // Exclude sigx packages from pre-bundling - they're ESM and aliased to source
                        exclude: ['sigx', '@sigx/reactivity', '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/server-renderer']
                    }
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
                        dedupe: [
                            'sigx',
                            '@sigx/reactivity',
                            '@sigx/runtime-core',
                            '@sigx/runtime-dom',
                            '@sigx/server-renderer',
                        ],
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
            if (!/\.tsx?$/.test(id) && !/\.jsx$/.test(id)) {
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
