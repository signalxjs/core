/**
 * Island chunk loading — facades over the core boundary chunk loader in
 * `@sigx/server-renderer/client`, translating between the islands-shaped
 * `IslandInfo` view and the generic boundary records.
 */

import {
    loadBoundaryComponent,
    prefetchBoundaryChunks,
    type ComponentFactory
} from '@sigx/server-renderer/client/scheduler';
import type { SSRBoundaryRecord, BoundaryHydrate } from '@sigx/server-renderer';
import type { IslandInfo } from '../types';

function infoToRecord(info: IslandInfo): SSRBoundaryRecord {
    const record: SSRBoundaryRecord = {};
    if (info.strategy === 'only') {
        record.flush = 'skip';
        record.hydrate = 'load';
    } else if (info.strategy !== undefined) {
        record.hydrate = info.strategy as BoundaryHydrate;
    }
    if (info.media !== undefined) record.media = info.media;
    if (info.props !== undefined) record.props = info.props;
    if (info.state !== undefined) record.state = info.state;
    if (info.componentId !== undefined) record.component = info.componentId;
    if (info.chunkUrl !== undefined) {
        record.chunk = { url: info.chunkUrl };
        if (info.exportName !== undefined) record.chunk.export = info.exportName;
    }
    return record;
}

/**
 * Load an island's component, trying all resolution paths
 * (eager registry → lazy registry → chunk URL).
 */
export async function loadIslandComponent(info: IslandInfo): Promise<ComponentFactory | undefined> {
    return loadBoundaryComponent(infoToRecord(info));
}

/**
 * Prefetch island chunks using `<link rel="modulepreload">`.
 * Call early (e.g. on DOMContentLoaded) to warm the browser cache
 * for islands that will hydrate later (visible, idle, interaction).
 */
export function prefetchIslandChunks(
    islands: Record<string, IslandInfo>,
    strategies: string[] = ['idle', 'visible', 'media', 'interaction']
): void {
    const table: Record<string, SSRBoundaryRecord> = {};
    for (const [id, info] of Object.entries(islands)) {
        table[id] = infoToRecord(info);
    }
    prefetchBoundaryChunks(table, strategies as BoundaryHydrate[]);
}
