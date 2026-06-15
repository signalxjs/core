/**
 * Island Chunk Loader
 *
 * Unified component resolution for island hydration — handles eager registry,
 * lazy registry, and direct chunk URL imports with in-flight deduplication.
 *
 * Resolution order:
 * 1. Eager registry (already loaded via registerComponent)
 * 2. Lazy registry (registered via __registerIslandChunk by the Vite plugin)
 * 3. Direct chunk URL (from SSR manifest via IslandInfo.chunkUrl)
 */

import { getComponent, resolveComponent, type ComponentFactory } from './registry';
import type { IslandInfo } from '../types';

/**
 * In-flight chunk load promises keyed by chunk URL — ensures we only
 * fetch each chunk once even if multiple islands reference it.
 */
const chunkLoadCache = new Map<string, Promise<ComponentFactory | undefined>>();

/**
 * Load an island's component, trying all resolution paths.
 *
 * @param info - The island's hydration info (from __SIGX_ISLANDS__ JSON)
 * @returns The resolved ComponentFactory, or undefined if not found
 */
export async function loadIslandComponent(info: IslandInfo): Promise<ComponentFactory | undefined> {
    const { componentId, chunkUrl, exportName } = info;

    if (!componentId) return undefined;

    // 1. Sync lookup — zero-cost if already loaded
    const eager = getComponent(componentId);
    if (eager) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`%c[Islands] ⚡ "${componentId}" resolved from eager registry (already loaded)`, 'color: #9e9e9e');
        }
        return eager;
    }

    // 2. Lazy registry (populated by Vite plugin transform)
    if (process.env.NODE_ENV !== 'production') {
        console.log(`%c[Islands] 📦 Loading chunk for "${componentId}"...`, 'color: #2196f3; font-weight: bold');
        const t0 = performance.now();
        const lazy = await resolveComponent(componentId);
        if (lazy) {
            const ms = (performance.now() - t0).toFixed(1);
            console.log(`%c[Islands] ✅ "${componentId}" chunk loaded in ${ms}ms`, 'color: #4caf50; font-weight: bold');
            return lazy;
        }
    } else {
        const lazy = await resolveComponent(componentId);
        if (lazy) return lazy;
    }

    // 3. Direct chunk URL (from SSR manifest)
    if (chunkUrl) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`%c[Islands] 🌐 Loading "${componentId}" from chunk URL: ${chunkUrl}`, 'color: #ff9800');
        }
        return loadFromChunkUrl(chunkUrl, exportName || 'default');
    }

    return undefined;
}

/**
 * Load a component from a chunk URL with deduplication.
 */
async function loadFromChunkUrl(
    url: string,
    exportName: string
): Promise<ComponentFactory | undefined> {
    const cached = chunkLoadCache.get(url);
    if (cached) return cached;

    const load = import(/* @vite-ignore */ url).then((mod: Record<string, any>) => {
        // Try named export matching component name
        if (mod[exportName] && typeof mod[exportName] === 'function' && '__setup' in mod[exportName]) {
            return mod[exportName] as ComponentFactory;
        }
        // Try default export
        if (mod.default && typeof mod.default === 'function' && '__setup' in mod.default) {
            return mod.default as ComponentFactory;
        }
        // First component export
        for (const val of Object.values(mod)) {
            if (val && typeof val === 'function' && '__setup' in (val as any)) {
                return val as ComponentFactory;
            }
        }

        if (process.env.NODE_ENV !== 'production') {
            console.warn(`[Islands] No component found in chunk: ${url}`);
        }
        return undefined;
    }).catch((err) => {
        chunkLoadCache.delete(url);
        if (process.env.NODE_ENV !== 'production') {
            console.error(`[Islands] Failed to load chunk ${url}:`, err);
        }
        return undefined;
    });

    chunkLoadCache.set(url, load);
    return load;
}

/**
 * Prefetch island chunks using `<link rel="modulepreload">`.
 * Call early (e.g. on DOMContentLoaded) to warm the browser cache
 * for islands that will hydrate later (client:visible, client:idle).
 *
 * @param islands - Island data from __SIGX_ISLANDS__
 * @param strategies - Only prefetch islands with these strategies (default: all deferred)
 */
export function prefetchIslandChunks(
    islands: Record<string, IslandInfo>,
    strategies: string[] = ['idle', 'visible', 'media']
): void {
    const seen = new Set<string>();

    for (const info of Object.values(islands)) {
        if (!info.chunkUrl) continue;
        if (strategies.length > 0 && !strategies.includes(info.strategy)) continue;
        if (seen.has(info.chunkUrl)) continue;
        seen.add(info.chunkUrl);

        const link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = info.chunkUrl;
        document.head.appendChild(link);
    }
}
