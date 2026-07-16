/**
 * Client-side signal restoration for SSR islands.
 *
 * The restoring-signal implementation was hoisted into
 * `@sigx/server-renderer` (#257) — counterpart of the hoisted tracking
 * signal (`../server/render-component` re-exports it). During hydration an
 * island's `ctx.signal` is swapped for this variant so each declared signal
 * seeds from the server-captured state instead of its literal initial value.
 */

export { createRestoringSignal } from '@sigx/server-renderer/client';
