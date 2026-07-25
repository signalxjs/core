/**
 * `@sigx/vite/assets` — the Vite client manifest → `DocumentOptions.assets`
 * resolver, and nothing else.
 *
 * Split out of `@sigx/vite/ssr` (#486). `collectAssets` is a pure function
 * over a parsed manifest, but it shared a module with the DEV request
 * handler, whose top level imports `node:fs/promises` and `node:path` — so
 * reaching it from a workerd/edge entry pulled `node:` builtins into a graph
 * that has none, and the only way to ship was to hand-port the function into
 * the app. This entry imports nothing at all.
 *
 * ```ts
 * const manifest = JSON.parse(readFileSync('dist/client/.vite/manifest.json', 'utf-8'));
 * const assets = collectAssets(manifest, ['src/entry-client.tsx']);
 * renderDocument(app, { template, assets });
 * ```
 *
 * `@sigx/vite/ssr` re-exports all of this, so existing imports are unchanged.
 */

// ============================================================================
// collectAssets — Vite client manifest → DocumentOptions.assets
// ============================================================================

/** One chunk entry of Vite's client build manifest (`.vite/manifest.json`). */
export interface ViteManifestChunk {
    file: string;
    src?: string;
    isEntry?: boolean;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

/** The `DocumentOptions.assets` shape from `@sigx/server-renderer`. */
export interface CollectedAssets {
    modulepreload: string[];
    stylesheets: string[];
}

/**
 * Resolve manifest entries into the `DocumentOptions.assets` shape
 * (rfc-ssr-platform §3.1): each entry's chunk plus its transitive STATIC
 * imports become `modulepreload` URLs; every visited chunk's CSS becomes a
 * stylesheet link. Dynamic imports are deliberately excluded — those are the
 * lazy boundaries, preloaded per boundary record by `renderDocument` itself.
 *
 * ```ts
 * const manifest = JSON.parse(readFileSync('dist/client/.vite/manifest.json', 'utf-8'));
 * const assets = collectAssets(manifest, ['src/entry-client.tsx']);
 * renderDocument(app, { template, assets });
 * ```
 *
 * @param entries - manifest keys (source-relative ids, e.g. 'src/entry-client.tsx')
 * @param base - public base path prefixed to every URL. Default '/'.
 */
export function collectAssets(
    manifest: ViteManifest,
    entries: string[],
    base = '/'
): CollectedAssets {
    const modulepreload: string[] = [];
    const stylesheets: string[] = [];
    const seenChunks = new Set<string>();
    const seenUrls = new Set<string>();
    const prefix = base.endsWith('/') ? base : base + '/';

    const push = (list: string[], file: string) => {
        const url = prefix + file;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        list.push(url);
    };

    const visit = (id: string) => {
        if (seenChunks.has(id)) return;
        seenChunks.add(id);
        const chunk = manifest[id];
        if (!chunk) {
            // No `process` on workerd/edge — this entry must not assume one.
            if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
                console.warn(`[sigx:ssr] collectAssets: "${id}" is not in the manifest — skipped.`);
            }
            return;
        }
        push(modulepreload, chunk.file);
        for (const css of chunk.css ?? []) {
            push(stylesheets, css);
        }
        for (const dep of chunk.imports ?? []) {
            visit(dep);
        }
    };

    for (const entry of entries) {
        visit(entry);
    }

    return { modulepreload, stylesheets };
}
