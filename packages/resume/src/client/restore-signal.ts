/**
 * Client-side signal restoration for resume upgrades.
 *
 * The implementation was hoisted into `@sigx/server-renderer` (#257) —
 * counterpart of the hoisted tracking signal (`../server/track-signal`
 * re-exports it). During upgrade the component's `ctx.signal` is swapped for
 * this variant so each declared signal seeds from the ORIGINAL
 * server-captured state (the DOM matches it; buffered writes replay
 * afterwards). The `report` callback hands each named live signal back so the
 * scope's facades can re-point to it.
 */

export { createRestoringSignal } from '@sigx/server-renderer/client';
