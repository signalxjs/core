/**
 * Island data cache and server state lookup for client-side hydration.
 * Moved from @sigx/server-renderer hydrate-context.ts (island-specific parts).
 */

import type { IslandInfo } from './types';

// ============= Island Data Cache =============

let _cachedIslandData: Record<string, IslandInfo> | null = null;

export function invalidateIslandCache(): void {
    _cachedIslandData = null;
}

export function getIslandData(): Record<string, IslandInfo> {
    if (_cachedIslandData !== null) {
        return _cachedIslandData;
    }

    const dataScript = document.getElementById('__SIGX_ISLANDS__');
    if (!dataScript) {
        _cachedIslandData = {};
        return _cachedIslandData!;
    }

    try {
        _cachedIslandData = JSON.parse(dataScript.textContent || '{}');
    } catch {
        console.error('Failed to parse island data');
        _cachedIslandData = {};
    }

    return _cachedIslandData!;
}

export function getIslandServerState(componentId: number): Record<string, any> | undefined {
    const islandData = getIslandData();
    const info = islandData[String(componentId)];
    return info?.state;
}
