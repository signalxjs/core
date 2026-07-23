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

// Export context utilities for plugins (the plugin registry itself is the
// eager `./client/scheduler` surface; re-exported here so barrel consumers
// see one API)
export {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    resolveClientPlugins,
    hasPendingClientPlugins,
    getCurrentAppContext,
    setCurrentAppContext
} from './plugin-registry';
export type { ClientPluginSource, LazyClientPlugin } from './plugin-registry';
export type { InternalVNode } from './hydrate-context';

// Hydration defaults — the per-app DI seam packs provide from install(app)
export { HYDRATE_DEFAULTS_TOKEN, provideHydrateDefaults, getHydrateDefaults } from './hydrate-defaults';
export type { HydrateDefaults } from './hydrate-defaults';

// App-carried SSR plugins — the install(app) seam packs register their
// server render hooks through (#413: one install shape, app.use)
export { SSR_PLUGINS_TOKEN, provideSSRPlugin, getSSRPlugins } from './ssr-plugins';

// The boundary scheduler (rfc-ssr-platform §1.2): table access, per-strategy
// scheduling, streamed-boundary wake-up. Also available standalone as the
// eager `@sigx/server-renderer/client/scheduler` entry, which is how a page
// defers the renderer until a strategy actually fires.
export {
    getBoundaryTable,
    getBoundaryRecord,
    installBoundaryRecords,
    removeBoundaryRecord,
    findBoundaryMarker,
    hydrateTableBoundary,
    scheduleTableBoundaries,
    scheduleByStrategy,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    isSkipPlaceholder,
    findComponentBoundaries,
    parseMarkerId,
    loadHydrationCore
} from './scheduler';
// The hydration executor (walk interception, streamed-boundary hydration) —
// the lazy half the scheduler imports on first trigger.
export { scheduleWalkedBoundary, hydrateLeftoverBoundaries } from './hydration-core';
export { seedBoundaryState, consumeBoundaryState } from './boundary-state';

// Restore side of "named = transferred" — seeds pack-swapped ctx.signal
// factories from server-captured state (see server/state-signals).
export { createRestoringSignal } from './restore-signal';

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
