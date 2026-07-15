/**
 * Signal tracking and state serialization for resume state transfer.
 *
 * The implementation was hoisted into `@sigx/server-renderer` (#257) — the
 * mechanism is strategy-agnostic, so every pack re-exports the one copy.
 * This module keeps the resume-facing names as thin aliases.
 */

import type { StateSignalFn } from '@sigx/server-renderer/server';

/**
 * Signal factory used by resumable components on the server — the resume name
 * for the hoisted `StateSignalFn`. The trailing `name` key is injected by the
 * `sigxResume()` Vite transform (never public component API); on the client
 * the same names become the resumed scope's `$scope.signals.<name>` entries,
 * so handler rewrites and state capture key off the same identifiers.
 */
export type ResumeSignalFn = StateSignalFn;

export { createTrackingSignal, serializeSignalState } from '@sigx/server-renderer/server';
