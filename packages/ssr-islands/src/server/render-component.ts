/**
 * Component rendering utilities for SSR islands.
 *
 * The tracking-signal / serialization implementation was hoisted into
 * `@sigx/server-renderer` (#257) — the mechanism is strategy-agnostic, so
 * every pack re-exports the one copy. This module keeps the islands-facing
 * names as thin aliases.
 */

import type { StateSignalFn } from '@sigx/server-renderer/server';

/**
 * Signal factory used by island components on the server — the islands name
 * for the hoisted `StateSignalFn`. The trailing `name` key is injected by the
 * `sigxIslands()` Vite transform (never public component API).
 */
export type SSRSignalFn = StateSignalFn;

export { createTrackingSignal, serializeSignalState } from '@sigx/server-renderer/server';
