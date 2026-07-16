/**
 * Islands client entry points — thin facades over the core boundary
 * SCHEDULER in `@sigx/server-renderer/client/scheduler` (rfc-ssr-platform
 * §1.2: selective hydration IS the hydrator; islands is the directive
 * mapping).
 *
 * This module is the islands package's eager surface: it imports only the
 * runtime-free scheduler entry, so a page whose islands are all deferred
 * (`client:idle` / `client:visible` / `client:interaction` / `client:media`)
 * executes ZERO sigx runtime code at load. The heavy pieces — the state
 * restoration hooks and the walk fallback — live in `./plugin-hooks`, which
 * `hydrateIslands()` registers as a lazy plugin source so it loads with the
 * hydration core on the first strategy that fires.
 */

import {
    scheduleTableBoundaries,
    registerClientPlugin,
    seedBoundaryState,
    consumeBoundaryState,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from '@sigx/server-renderer/client/scheduler';

export { cleanupPendingHydrations, invalidateMarkerIndex };

/**
 * Hydrate islands based on their strategies (selective hydration) — the
 * standalone islands-mode entry (no root walk). Equivalent to hydrating an
 * app whose default is `boundaries: 'explicit'`.
 *
 * Self-contained: the state-restoration hooks register themselves as a lazy
 * plugin source (loaded together with the hydration core, resolved before
 * the first component hydrates), so this one call is the whole client
 * bootstrap. Apps that already `registerClientPlugin(islandsPlugin())`
 * keep working — plugin registration dedupes by name, first-wins.
 */
export function hydrateIslands(): void {
    registerClientPlugin({
        name: 'islands',
        load: () => import('./plugin-hooks.js').then((m) => m.islandsClientHooks)
    });
    scheduleTableBoundaries();
}

/**
 * Stage island server-state before a `hydrateComponent` call — facade over
 * the core staging seam (the islands plugin's client
 * `transformComponentContext` consumes it to seed restored signals).
 */
export function seedPendingServerState(state: Record<string, any> | null | undefined): void {
    seedBoundaryState(state);
}

/** Read and clear the pending island server-state. */
export function consumePendingServerState(): Record<string, any> | null {
    return consumeBoundaryState();
}
