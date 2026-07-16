/**
 * Async (streamed) island hydration — owned by the core boundary hydrator:
 * `@sigx/server-renderer` installs the `sigx:async-ready` listener and runs
 * the leftover scan after hydrate(). This facade keeps the islands name for
 * direct callers, loading the hydration executor on demand so it can live
 * on the package's eager, runtime-free client entry.
 */

import { loadHydrationCore } from '@sigx/server-renderer/client/scheduler';

/**
 * Scan `container` for streamed-in async boundaries that have not hydrated
 * yet and hydrate them. Returns a promise because the hydration executor
 * loads lazily — callers that only fire-and-forget can ignore it.
 */
export async function hydrateLeftoverAsyncComponents(container: Element): Promise<void> {
    const core = await loadHydrationCore();
    core.hydrateLeftoverBoundaries(container);
}
