/**
 * @sigx/server-renderer/client
 * 
 * Client-side hydration — strategy-agnostic core.
 * Plugin-based extension for islands, resumable SSR, etc.
 */

// Load SSR type augmentations (SSRHelper, ComponentSetupContext extensions)
import '../client-directives.js';

// Load context extension (side-effect: registers SSR context for all components)
import './hydrate-context';

// Export the SSR client plugin (recommended way to hydrate)
export { ssrClientPlugin, type HydrateFn } from './plugin.js';

// Export core hydration
export { hydrate, hydrateNode } from './hydrate-core';

// Export component hydration (used by SSR strategy plugins)
export { hydrateComponent } from './hydrate-component';
// The registry's factory type extends hydrate-component's with __islandId.
export type { ComponentFactory } from './registry';

// Export context utilities for plugins
export {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    getCurrentAppContext,
    setCurrentAppContext
} from './hydrate-context';
export type { InternalVNode } from './hydrate-context';

// Hydration defaults — the per-app DI seam packs provide from install(app)
export { HYDRATE_DEFAULTS_TOKEN, provideHydrateDefaults, getHydrateDefaults } from './hydrate-defaults';
export type { HydrateDefaults } from './hydrate-defaults';

// The boundary hydrator (rfc-ssr-platform §1.2): table access, per-strategy
// scheduling, walk interception, streamed-boundary hydration
export {
    getBoundaryTable,
    getBoundaryRecord,
    scheduleTableBoundaries,
    scheduleWalkedBoundary,
    scheduleByStrategy,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    hydrateLeftoverBoundaries,
    isSkipPlaceholder,
    findComponentBoundaries,
    parseMarkerId
} from './boundary-hydrator';
export { seedBoundaryState, consumeBoundaryState } from './boundary-state';

// Component registry + chunk loading for on-demand boundary mounting
export {
    registerComponent,
    registerComponents,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    HydrationRegistry
} from './registry';
export type { LazyComponentLoader } from './registry';
export { loadBoundaryComponent, prefetchBoundaryChunks } from './chunk-loader';
