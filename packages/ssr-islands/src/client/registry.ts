/**
 * Component registry — re-exported from the core boundary hydrator
 * (`@sigx/server-renderer/client`), where the machinery moved
 * (rfc-ssr-platform §1.2). The islands names remain the authoring surface;
 * `@sigx/vite`'s island transform keeps importing `__registerIslandChunk`
 * from here.
 */

export {
    registerComponent,
    registerComponents,
    __registerIslandChunk,
    resolveComponent,
    getComponent,
    hasComponent,
    HydrationRegistry
} from '@sigx/server-renderer/client';
export type { ComponentFactory, LazyComponentLoader } from '@sigx/server-renderer/client';
