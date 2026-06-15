/**
 * Shared types for client-side island hydration
 */

export type { VNode } from 'sigx';

// Re-export the single, package-wide IslandInfo so `@sigx/ssr-islands/client`
// and the main entry never expose two divergent shapes (the local copy here
// used to omit chunkUrl/exportName/placeholder).
export type { IslandInfo } from '../types';

/**
 * Hydration options
 */
export interface HydrationOptions {
    recover?: boolean;
    onMismatch?: (message: string, node: Node | null, vnode: any) => void;
}
