/**
 * @sigx/ssr-islands
 *
 * Islands architecture plugin for SigX SSR.
 * Provides selective hydration via client:* directives.
 *
 * ## Server Usage (the entry-server's per-request app factory)
 * ```ts
 * import { defineApp } from 'sigx';
 * import { createSSR } from '@sigx/server-renderer';
 * import { islandsPlugin } from '@sigx/ssr-islands';
 *
 * const app = defineApp(<App />).use(islandsPlugin({ manifest }));
 * const html = await createSSR().render(app);
 * ```
 *
 * ## Client Usage
 * ```ts
 * // Prefer the LIGHT entry — this root entry pulls the plugin (and the
 * // sigx runtime) onto the page's eager graph:
 * import { hydrateIslands, registerComponent } from '@sigx/ssr-islands/client';
 *
 * registerComponent('Counter', Counter);
 * hydrateIslands();
 * ```
 *
 * ## JSX Types
 * The client:* JSX types load automatically when you import anything from
 * `@sigx/ssr-islands`. For a types-only setup, reference them directly (this is a
 * type-only entry — do not `import` it at runtime):
 * ```ts
 * /// <reference types="@sigx/ssr-islands/jsx" />
 * <Counter client:visible />
 * <Widget client:idle />
 * ```
 *
 * @module
 */

// Plugin
export { islandsPlugin } from './plugin';
export type { IslandsPluginOptions, IslandsManifestV2, IslandManifestEntry } from './plugin';

// Client
export {
    hydrateIslands,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from './client/hydrate-islands';
// The walk fallback is heavy by nature (it feeds the hydration executor) —
// exported from this root entry only; the /client entry stays runtime-free.
export { scheduleComponentHydration } from './client/plugin-hooks';
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

// Types
export type { IslandInfo, PendingAsyncComponent, HydrationStrategy } from './types';
export type { HydrationOptions } from './client/types';
export type { ClientDirectives } from './client-directives';

// Re-export shared SSR helper type from server-renderer (convenience)
export type { SSRHelper } from '@sigx/server-renderer';

// Side-effect import: registers module augmentation for client:* directives
// on ComponentAttributeExtensions so TypeScript accepts them on components.
import './client-directives';
