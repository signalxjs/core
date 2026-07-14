/**
 * Island types — shared between server and client.
 */

export interface IslandInfo {
    /** Hydration strategy: 'load' | 'idle' | 'visible' | 'media' | 'only' */
    strategy: HydrationStrategy;
    /** Media query for 'media' strategy */
    media?: string;
    /** Component props to serialize for client hydration */
    props?: Record<string, any>;
    /** Component identifier for client (path-based when injected by Vite plugin, or component name as fallback) */
    componentId?: string;
    /** Captured signal state from async setup for client hydration */
    state?: Record<string, any>;
    /** Placeholder HTML for streaming async components */
    placeholder?: string;
    /** URL of the JS chunk containing this island's component code (for lazy loading) */
    chunkUrl?: string;
    /** Named export within the chunk (defaults to componentId) */
    exportName?: string;
}

export interface PendingAsyncComponent {
    /** Component ID */
    id: number;
    /** Promise that resolves to rendered HTML */
    promise: Promise<string>;
    /** Signal state captured during render */
    signalMap: Map<string, any>;
    /** Island info reference */
    islandInfo: IslandInfo;
}

export type HydrationStrategy = 'load' | 'idle' | 'visible' | 'media' | 'interaction' | 'only';
