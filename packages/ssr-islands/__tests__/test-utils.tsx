/**
 * Shared test utilities for ssr-islands tests
 * Re-exports common utilities from server-renderer's test-utils
 * and adds islands-specific helpers.
 */

import { component } from 'sigx';
import { invalidateIslandCache } from '../src/client/island-context';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';

export {
    createSSRContainer,
    cleanupContainer,
    ssrElement,
    ssrComponentMarkers,
    ssrIslandMarkers,
    ssrTextSeparator,
    escapeHtml,
    nextTick,
    waitForIdle,
    createVNode,
    createTextVNode,
    createFragmentVNode,
    TestCounter,
    TestCounterWithProps,
    TestText,
    TestWrapper,
    TestMountHook,
    TestButton,
} from '../../server-renderer/__tests__/test-utils';

// `SSRSignalFn` is island-specific (the tracked-signal contract). It used to
// live in server-renderer's test-utils; it now lives in this package's source.
export type { SSRSignalFn } from '../src/server/render-component';
import type { SSRSignalFn } from '../src/server/render-component';

/**
 * Clear the boundary table between tests (replaces the old
 * `__SIGX_ISLANDS__` script removal — the table is a window global now).
 */
export function cleanupScripts(): void {
    delete (window as any).__SIGX_BOUNDARIES__;
    invalidateIslandCache();
}

/** IslandInfo-shaped fixture → SSRBoundaryRecord (the wire shape). */
function islandInfoToRecord(info: Record<string, any>): SSRBoundaryRecord {
    const record: SSRBoundaryRecord = {};
    if (info.strategy === 'only') {
        record.flush = 'skip';
        record.hydrate = 'load';
    } else if (info.strategy !== undefined) {
        record.hydrate = info.strategy;
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
 * Install a boundary table (window.__SIGX_BOUNDARIES__) from IslandInfo-shaped
 * fixtures — the pre-boundary-model helper name is kept so scheduling tests,
 * which exercise strategies rather than the wire, stay readable. jsdom does
 * not execute injected scripts, so the global is set directly (exactly what
 * the executable assignment would do in a browser).
 */
export function createIslandDataScript(data: Record<string, any>): void {
    setBoundaryTable(Object.fromEntries(
        Object.entries(data).map(([id, info]) => [id, islandInfoToRecord(info)])
    ));
}

/** Install a boundary table from raw SSRBoundaryRecord entries. */
export function setBoundaryTable(records: Record<string, SSRBoundaryRecord>): void {
    (window as any).__SIGX_BOUNDARIES__ = Object.assign(
        Object.create(null),
        (window as any).__SIGX_BOUNDARIES__,
        records
    );
    invalidateIslandCache();
}

/**
 * Component with a keyed tracked signal for island state-restoration testing.
 * Moved here from server-renderer's test-utils. The explicit 2-arg call
 * (`ctx.signal as SSRSignalFn`) emulates what the `sigxIslands()` vite
 * transform injects from the declaration identifier in real apps — the key is
 * a transform↔runtime contract, not public component API.
 */
export const TestAsyncCounter = component((ctx) => {
    const ssrSignal = ctx.signal as SSRSignalFn;
    const count = ssrSignal({ value: 0 }, 'count');

    return () => (
        <div class="async-counter">
            <span class="count">{count.value}</span>
        </div>
    );
}, { name: 'TestAsyncCounter' });

/**
 * Parse the raw __SIGX_BOUNDARIES__ table (id → SSRBoundaryRecord) out of
 * rendered HTML — the executable-assignment script emitted by core.
 */
export function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    // JSON.parse handles the <-style escaping natively.
    return JSON.parse(match[1]);
}

/**
 * Parse island data from rendered HTML as the IslandInfo-shaped view —
 * boundary records mapped back onto strategy/componentId/chunkUrl fields so
 * pre-boundary-model assertions keep reading naturally. Wire-level tests
 * should use {@link parseBoundaryTable} instead.
 */
export function parseIslandData(html: string): Record<string, any> {
    const table = parseBoundaryTable(html);
    const out: Record<string, any> = {};
    for (const [id, record] of Object.entries(table)) {
        const info: Record<string, any> = {
            strategy: record.flush === 'skip' ? 'only' : (record.hydrate ?? 'load')
        };
        if (record.media !== undefined) info.media = record.media;
        if (record.props !== undefined) info.props = record.props;
        if (record.state !== undefined) info.state = record.state;
        if (record.component !== undefined) info.componentId = record.component;
        if (record.chunk) {
            info.chunkUrl = record.chunk.url;
            if (record.chunk.export !== undefined) info.exportName = record.chunk.export;
        }
        out[id] = info;
    }
    return out;
}
