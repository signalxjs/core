/**
 * Boundary chunk loader.
 *
 * Unified component resolution for boundary hydration — handles eager
 * registry, lazy registry, and direct chunk URL imports with in-flight
 * deduplication.
 *
 * Resolution order:
 * 1. Eager registry (already loaded via registerComponent)
 * 2. Lazy registry (registered via __registerIslandChunk by the Vite plugin)
 * 3. Direct chunk URL (the record's `chunk` ref from the SSR manifest)
 *
 * Moved here from the islands pack (rfc-ssr-platform §1.2); operates on
 * the generic SSRBoundaryRecord.
 */

import { getComponent, resolveComponent, unwrapComponentModule, type ComponentFactory } from './registry';
import type { SSRBoundaryRecord, BoundaryHydrate } from '../boundary';

/**
 * In-flight chunk load promises keyed by chunk URL — ensures we only
 * fetch each chunk once even if multiple boundaries reference it.
 */
const chunkLoadCache = new Map<string, Promise<ComponentFactory | undefined>>();

/**
 * Load a boundary's component, trying all resolution paths.
 *
 * @param record - The boundary's record (from the __SIGX_BOUNDARIES__ table)
 * @returns The resolved ComponentFactory, or undefined if not found
 */
export async function loadBoundaryComponent(record: SSRBoundaryRecord): Promise<ComponentFactory | undefined> {
    const name = record.component;
    if (!name) return undefined;

    // 1. Sync lookup — zero-cost if already loaded
    const eager = getComponent(name);
    if (eager) {
        if (__DEV__) {
            console.log(`%c[Islands] ⚡ "${name}" resolved from eager registry (already loaded)`, 'color: #9e9e9e');
        }
        return eager;
    }

    // 2. Lazy registry (populated by Vite plugin transform)
    if (__DEV__) {
        console.log(`%c[Islands] 📦 Loading chunk for "${name}"...`, 'color: #2196f3; font-weight: bold');
        const t0 = performance.now();
        const lazy = await resolveComponent(name);
        if (lazy) {
            const ms = (performance.now() - t0).toFixed(1);
            console.log(`%c[Islands] ✅ "${name}" chunk loaded in ${ms}ms`, 'color: #4caf50; font-weight: bold');
            return lazy;
        }
    } else {
        const lazy = await resolveComponent(name);
        if (lazy) return lazy;
    }

    // 3. Direct chunk URL (from SSR manifest)
    if (record.chunk?.url) {
        if (__DEV__) {
            console.log(`%c[Islands] 🌐 Loading "${name}" from chunk URL: ${record.chunk.url}`, 'color: #ff9800');
        }
        return loadFromChunkUrl(record.chunk.url, record.chunk.export || 'default', name);
    }

    return undefined;
}

/**
 * Load a component from a chunk URL with deduplication.
 */
async function loadFromChunkUrl(
    url: string,
    exportName: string,
    name: string
): Promise<ComponentFactory | undefined> {
    const cached = chunkLoadCache.get(url);
    if (cached) return cached;

    const load = import(/* @vite-ignore */ url).then((mod: Record<string, any>) => {
        // Try the named export first, then the generic unwrap
        if (mod[exportName] && typeof mod[exportName] === 'function' && '__setup' in mod[exportName]) {
            return mod[exportName] as ComponentFactory;
        }
        const component = unwrapComponentModule(mod as any, name);
        if (!component && __DEV__) {
            console.warn(`[Islands] No component found in chunk: ${url}`);
        }
        return component;
    }).catch((err) => {
        chunkLoadCache.delete(url);
        if (__DEV__) {
            console.error(`[Islands] Failed to load chunk ${url}:`, err);
        }
        return undefined;
    });

    chunkLoadCache.set(url, load);
    return load;
}

/**
 * Prefetch boundary chunks using `<link rel="modulepreload">`.
 * Call early (e.g. on DOMContentLoaded) to warm the browser cache
 * for boundaries that will hydrate later (visible, idle, interaction).
 *
 * @param table - Boundary records from the __SIGX_BOUNDARIES__ table
 * @param strategies - Only prefetch boundaries with these hydrate strategies
 */
export function prefetchBoundaryChunks(
    table: Record<string, SSRBoundaryRecord>,
    strategies: BoundaryHydrate[] = ['idle', 'visible', 'media', 'interaction']
): void {
    const seen = new Set<string>();

    for (const record of Object.values(table)) {
        const url = record.chunk?.url;
        if (!url) continue;
        if (strategies.length > 0 && !strategies.includes(record.hydrate ?? 'load')) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = url;
        document.head.appendChild(link);
    }
}
