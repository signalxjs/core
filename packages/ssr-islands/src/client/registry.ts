/**
 * Component registry — re-exported from the core boundary SCHEDULER
 * (`@sigx/server-renderer/client/scheduler`), where the machinery moved
 * (rfc-ssr-platform §1.2). The islands names remain the authoring surface;
 * `@sigx/vite`'s island transform keeps importing `__registerIslandChunk`
 * from here. The scheduler entry (not the heavy barrel) keeps this facade
 * on the islands package's eager, runtime-free surface.
 */

export {
    registerComponent,
    registerComponents,
    __registerIslandChunk,
    resolveComponent,
    getComponent,
    hasComponent,
    HydrationRegistry
} from '@sigx/server-renderer/client/scheduler';
export type { ComponentFactory, LazyComponentLoader } from '@sigx/server-renderer/client/scheduler';
