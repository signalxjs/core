/**
 * Shared types for client-side island hydration
 */

export type { VNode } from 'sigx';

/**
 * Hydration options
 */
export interface HydrationOptions {
    recover?: boolean;
    onMismatch?: (message: string, node: Node | null, vnode: any) => void;
}

/**
 * Island information serialized from server
 */
export interface IslandInfo {
    strategy: 'load' | 'idle' | 'visible' | 'media' | 'only';
    media?: string;
    props?: Record<string, any>;
    componentId?: string;
    /** Captured signal state from async setup for client hydration */
    state?: Record<string, any>;
}
