/**
 * Library build utilities for SignalX packages using Vite 8's built-in Rolldown bundler.
 * 
 * This module provides a `defineLibConfig` helper that simplifies creating library builds
 * with consistent configuration across all @sigx/* packages.
 */
import { defineConfig, type UserConfig, type UserConfigFnObject } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Types
// ============================================================================

export interface LibEntry {
    /** Entry name (becomes output filename without extension) */
    name: string;
    /** Entry file path relative to project root */
    entry: string;
}

export interface LibBuildOptions {
    /**
     * Single entry point or multiple entry points
     * @example 'src/index.ts'
     * @example [{ name: 'index', entry: 'src/index.ts' }, { name: 'utils', entry: 'src/utils.ts' }]
     */
    entry: string | Record<string, string> | LibEntry[];

    /**
     * Output directory
     * @default 'dist'
     */
    outDir?: string;

    /**
     * Enable sourcemaps
     * @default true
     */
    sourcemap?: boolean;

    /**
     * External dependencies (will not be bundled)
     * @default [/@sigx\/.* /] - all @sigx/* packages
     */
    external?: (string | RegExp)[];

    /**
     * Path aliases for bundling sibling packages
     * Keys are import paths, values are file paths relative to project root
     */
    alias?: Record<string, string>;

    /**
     * Enable minification (produces additional .min.js files)
     * @default true
     */
    minify?: boolean;

    /**
     * Banner to prepend to output (e.g., shebang for CLI tools)
     */
    banner?: string;

    /**
     * Enable JSX transform for sigx
     * @default false
     */
    jsx?: boolean;

    /**
     * The module the automatic JSX runtime imports from. Only read when
     * `jsx` is enabled. Platform packages that build their own components
     * target their runtime directly (e.g. `@sigx/runtime-core`) instead of
     * the `sigx` umbrella, which carries the DOM renderer.
     * @default 'sigx'
     */
    importSource?: string;

    /**
     * Platform target
     * @default 'browser'
     */
    platform?: 'browser' | 'node' | 'neutral';

    /**
     * The directory containing package.json (used to resolve aliases)
     * Pass import.meta.url from your vite.config.ts
     */
    root?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeEntries(entry: LibBuildOptions['entry']): Record<string, string> {
    if (typeof entry === 'string') {
        return { index: entry };
    }
    if (Array.isArray(entry)) {
        return Object.fromEntries(entry.map(e => [e.name, e.entry]));
    }
    return entry;
}

function resolveAliases(
    alias: Record<string, string> | undefined,
    root: string
): Record<string, string> {
    if (!alias) return {};
    
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(alias)) {
        resolved[key] = path.resolve(root, value);
    }
    return resolved;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Define a Vite library build configuration for SignalX packages.
 * 
 * @example Basic single-entry library:
 * ```ts
 * import { defineLibConfig } from '@sigx/vite/lib';
 * 
 * export default defineLibConfig({
 *     entry: 'src/index.ts'
 * });
 * ```
 * 
 * @example Multi-entry library with subpath exports:
 * ```ts
 * import { defineLibConfig } from '@sigx/vite/lib';
 * 
 * export default defineLibConfig({
 *     entry: {
 *         'index': 'src/index.ts',
 *         'server/index': 'src/server/index.ts',
 *         'client/index': 'src/client/index.ts'
 *     },
 *     external: ['sigx', /@sigx\/.* /]
 * });
 * ```
 * 
 * @example Bundling with aliases (like sigx main package):
 * ```ts
 * import { defineLibConfig } from '@sigx/vite/lib';
 * 
 * export default defineLibConfig({
 *     entry: {
 *         'sigx': 'src/index.ts',
 *         'hydration': 'src/hydration.ts'
 *     },
 *     alias: {
 *         '@sigx/reactivity': '../reactivity/src/index.ts',
 *         '@sigx/runtime-core': '../runtime-core/src/index.ts',
 *         '@sigx/runtime-dom': '../runtime-dom/src/index.ts'
 *     },
 *     minify: true,  // Also produce sigx.min.js
 *     root: import.meta.url
 * });
 * ```
 */
/**
 * Externals that every @sigx library build must keep out of its bundle to
 * preserve singleton reactivity. If any of these end up inlined, consumers
 * get two physical copies of `@sigx/reactivity` (one inlined here, one
 * resolved through the consumer's own dependency graph) and signal effects
 * created via one copy will never fire effects tracked by the other.
 *
 * Always pre-pended to the caller's `external` list — callers don't need to
 * remember and can't accidentally drop them by passing their own `external`.
 */
const SIGX_RUNTIME_EXTERNALS: (string | RegExp)[] = [
    'sigx',
    /^sigx\//,
    '@sigx/reactivity',
    /^@sigx\/reactivity\//,
    '@sigx/runtime-core',
    /^@sigx\/runtime-core\//,
    '@sigx/runtime-dom',
    /^@sigx\/runtime-dom\//,
    '@sigx/server-renderer',
    /^@sigx\/server-renderer\//,
];

export function defineLibConfig(options: LibBuildOptions): UserConfigFnObject {
    const {
        entry,
        outDir = 'dist',
        sourcemap = true,
        external = [/@sigx\/.*/],
        alias,
        minify = true,
        banner,
        jsx = false,
        importSource = 'sigx',
        platform = 'browser',
        root = process.cwd(),
    } = options;

    // Resolve root directory from import.meta.url if provided
    const rootDir = root.startsWith('file://')
        ? path.dirname(fileURLToPath(root))
        : root;

    const entries = normalizeEntries(entry);
    const resolvedAliases = resolveAliases(alias, rootDir);

    // Always treat the sigx runtime tier as external, regardless of what the
    // caller passed. De-dupe in case it's already in their list.
    const seen = new Set<string>();
    const mergedExternal: (string | RegExp)[] = [];
    for (const ext of [...SIGX_RUNTIME_EXTERNALS, ...external]) {
        const key = ext instanceof RegExp ? `re:${ext.source}` : `str:${ext}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mergedExternal.push(ext);
    }

    // Convert external patterns for Vite 8's rolldownOptions
    const externalPatterns = mergedExternal.map(ext => {
        if (ext instanceof RegExp) {
            return ext;
        }
        return ext;
    });

    return defineConfig(({ mode }) => {
        // `vite build --mode prod-dist` emits the production dist next to the
        // default (development) dist: process.env.NODE_ENV is defined away so
        // dev warnings and devtools plumbing are stripped, and every output
        // file gets a `.prod.js` suffix for the package's `production` export
        // condition. Run it as a second pass after the default build.
        const prodDist = mode === 'prod-dist';

        const config: UserConfig = {
            root: rootDir,

            resolve: {
                alias: resolvedAliases
            },

            // `__DEV__` is the compile-time dev flag used in package sources.
            // The prod pass pins it to `false` so the minifier strips guarded
            // blocks; the dev pass re-emits the runtime NODE_ENV check so the
            // dev dist behaves exactly as before (the consumer's bundler or
            // Node decides at their build/run time).
            define: {
                __DEV__: prodDist
                    ? 'false'
                    : "(process.env.NODE_ENV !== 'production')",
                ...(prodDist && {
                    'process.env.NODE_ENV': JSON.stringify('production')
                })
            },

            build: {
                outDir,
                sourcemap,
                // The prod-dist pass writes into the dev dist's outDir.
                emptyOutDir: !prodDist,

                lib: {
                    entry: entries,
                    formats: ['es'],
                    fileName: (_format, entryName) =>
                        prodDist ? `${entryName}.prod.js` : `${entryName}.js`
                },

                // Vite 8 uses rolldownOptions instead of rollupOptions
                rolldownOptions: {
                    external: externalPatterns,
                    output: {
                        ...(banner && { banner }),
                        ...(prodDist && { chunkFileNames: '[name]-[hash].prod.js' })
                    }
                },

                // Platform-specific settings
                ...(platform === 'node' && {
                    target: 'node18'
                }),

                // Minification handled by Vite 8's Oxc minifier
                minify: minify ? 'oxc' : false
            },

            // JSX configuration for Vite 8 using Oxc
            ...(jsx && {
                oxc: {
                    jsx: {
                        runtime: 'automatic',
                        importSource
                    }
                }
            })
        };

        return config;
    });
}

/**
 * Create multiple build configurations for packages that need separate builds
 * (e.g., minified + non-minified, or different platform targets).
 * 
 * Note: Vite doesn't support array configs like Rolldown did directly.
 * Use this with a build script that runs vite build multiple times with different configs.
 * 
 * @example
 * ```ts
 * // In vite.config.ts
 * import { defineLibConfig } from '@sigx/vite/lib';
 * 
 * const config = process.env.MINIFY === 'true'
 *     ? defineLibConfig({ entry: 'src/index.ts', minify: true })
 *     : defineLibConfig({ entry: 'src/index.ts' });
 * 
 * export default config;
 * ```
 */
export { defineConfig };
