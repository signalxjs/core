/**
 * Boundary-table read + island-shaped view for client-side hydration.
 *
 * The server emits one `window.__SIGX_BOUNDARIES__` table (core protocol,
 * rfc-ssr-platform §1.1) — an executable assignment, so the client reads a
 * plain global instead of parsing a DOM script. This module maps the generic
 * boundary records onto the islands-shaped `IslandInfo` view the scheduler
 * consumes.
 */

import type { IslandInfo, HydrationStrategy } from '../types';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';

// ============= Island Data Cache =============

let _cachedIslandData: Record<string, IslandInfo> | null = null;

/**
 * Drop the cached view. Mid-stream patches REPLACE the global (each
 * assignment builds a fresh null-prototype object), so the sigx:async-ready
 * flow invalidates before re-reading.
 */
export function invalidateIslandCache(): void {
    _cachedIslandData = null;
}

function recordToIslandInfo(record: SSRBoundaryRecord): IslandInfo {
    const info: IslandInfo = {
        // flush: 'skip' is the client:only decomposition — the client
        // fresh-mounts instead of hydrating, which the scheduler spells
        // 'only'. Records without a hydrate strategy inherit 'load'.
        strategy: (record.flush === 'skip' ? 'only' : (record.hydrate ?? 'load')) as HydrationStrategy
    };
    if (record.media !== undefined) info.media = record.media;
    if (record.props !== undefined) info.props = record.props;
    if (record.component !== undefined) info.componentId = record.component;
    if (record.state !== undefined) info.state = record.state;
    if (record.chunk) {
        info.chunkUrl = record.chunk.url;
        if (record.chunk.export !== undefined) info.exportName = record.chunk.export;
    }
    return info;
}

export function getIslandData(): Record<string, IslandInfo> {
    if (_cachedIslandData !== null) {
        return _cachedIslandData;
    }

    const table = (typeof window !== 'undefined'
        ? (window as any).__SIGX_BOUNDARIES__
        : undefined) as Record<string, SSRBoundaryRecord> | undefined;

    const view: Record<string, IslandInfo> = {};
    if (table) {
        for (const id in table) {
            // hydrate: 'never' has no islands spelling — those boundaries
            // are not islands and never hydrate; keep them out of the view
            // rather than coercing an impossible strategy value.
            if (table[id].hydrate === 'never') continue;
            view[id] = recordToIslandInfo(table[id]);
        }
    }
    _cachedIslandData = view;
    return view;
}

export function getIslandServerState(componentId: number): Record<string, any> | undefined {
    const islandData = getIslandData();
    const info = islandData[String(componentId)];
    return info?.state;
}
