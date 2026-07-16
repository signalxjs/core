/**
 * Async (streamed) island hydration — owned by the core boundary hydrator
 * now: `@sigx/server-renderer/client` installs the `sigx:async-ready`
 * listener and runs the leftover scan after hydrate(). This facade keeps the
 * islands name for direct callers.
 */

export { hydrateLeftoverBoundaries as hydrateLeftoverAsyncComponents } from '@sigx/server-renderer/client';
