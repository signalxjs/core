/**
 * @sigx/ssr-islands/client
 *
 * Client-side island hydration utilities.
 */

// Load client directive type augmentations
import '../client-directives';

// Export islands hydration
export {
    hydrateIslands,
    scheduleComponentHydration,
    initIslandHydration
} from './hydrate-islands';

// Export async hydration
export { hydrateLeftoverAsyncComponents } from './hydrate-async';

// Export registry
export {
    registerComponent,
    registerComponents,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    HydrationRegistry
} from './registry';
export type { ComponentFactory, LazyComponentLoader } from './registry';

// Export chunk loader
export { loadIslandComponent, prefetchIslandChunks } from './chunk-loader';

// Export island context
export {
    invalidateIslandCache,
    getIslandData,
    getIslandServerState
} from './island-context';

// Export types
export type { HydrationOptions, IslandInfo } from './types';
