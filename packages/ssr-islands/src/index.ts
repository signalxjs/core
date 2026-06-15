/**
 * @sigx/ssr-islands
 *
 * Islands architecture plugin for SigX SSR.
 * Provides selective hydration via client:* directives.
 *
 * ## Server Usage
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * import { islandsPlugin } from '@sigx/ssr-islands';
 *
 * const ssr = createSSR().use(islandsPlugin());
 * const html = await ssr.render(<App />);
 * ```
 *
 * ## Client Usage
 * ```ts
 * import { hydrateIslands, registerComponent } from '@sigx/ssr-islands';
 *
 * registerComponent('Counter', Counter);
 * hydrateIslands();
 * ```
 *
 * ## JSX Types
 * ```ts
 * import '@sigx/ssr-islands/jsx';
 * <Counter client:visible />
 * <Widget client:idle />
 * ```
 *
 * @module
 */

// Plugin
export { islandsPlugin } from './plugin';
export type { IslandsPluginOptions } from './plugin';

// Client
export {
    hydrateIslands,
    scheduleComponentHydration,
    initIslandHydration,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from './client/hydrate-islands';
export { hydrateLeftoverAsyncComponents } from './client/hydrate-async';
export {
    registerComponent,
    registerComponents,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    HydrationRegistry
} from './client/registry';
export type { ComponentFactory, LazyComponentLoader } from './client/registry';
export {
    loadIslandComponent,
    prefetchIslandChunks
} from './client/chunk-loader';
export {
    invalidateIslandCache,
    getIslandData,
    getIslandServerState
} from './client/island-context';

// Server
export { createTrackingSignal, serializeSignalState } from './server/render-component';
export type { SSRSignalFn } from './server/render-component';
export { generateIslandDataScript } from './server/render-islands';

// Types
export type { IslandInfo, PendingAsyncComponent, HydrationStrategy } from './types';
export type { HydrationOptions } from './client/types';
export type { ClientDirectives } from './client-directives';

// Re-export shared SSR helper type from server-renderer (convenience)
export type { SSRHelper } from '@sigx/server-renderer';

// Side-effect import: registers module augmentation for client:* directives
// on ComponentAttributeExtensions so TypeScript accepts them on components.
import './client-directives';
