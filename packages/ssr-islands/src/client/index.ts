/**
 * @sigx/ssr-islands/client
 *
 * Client-side island hydration utilities — the package's EAGER surface.
 * Everything here rides `@sigx/server-renderer/client/scheduler` (the
 * runtime-free scheduler entry): `hydrateIslands()` is the whole client
 * bootstrap, and the sigx runtime + restoration hooks load lazily on the
 * first island strategy that fires. Guarded by a no-ignore size-limit
 * entry and a structural import test.
 *
 * `scheduleComponentHydration` (the walk fallback — heavy by nature) lives
 * on the root `@sigx/ssr-islands` entry.
 */

// Load client directive type augmentations
import '../client-directives';

// Export islands hydration
export { hydrateIslands, seedPendingServerState, consumePendingServerState } from './hydrate-islands';

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
