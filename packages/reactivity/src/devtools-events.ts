/**
 * Reactivity-layer devtools events.
 *
 * Emitted by `signal()`, `computed()`, and `effect()` when a hook is
 * installed. The id space is shared with the rest of the runtime
 * (component instances, app contexts) via `hook.nextId()`.
 *
 * `ownerComponentId` is captured at creation time from `hook.currentOwner`
 * — set by `runtime-core`'s component setup wrapper. Reactivity itself
 * never knows about components.
 */

import type { DevtoolsEventBase } from './devtools-hook';

export type ReactivityKind = 'primitive' | 'object' | 'collection';

export type ReactivityDevtoolsEvent =
    | { type: 'signal:created';     id: number; kind: ReactivityKind; ownerComponentId: number | null }
    | { type: 'signal:updated';     id: number; key: string }
    | { type: 'computed:created';   id: number; ownerComponentId: number | null }
    | { type: 'computed:recomputed'; id: number }
    | { type: 'effect:created';     id: number; ownerComponentId: number | null }
    | { type: 'effect:run';         id: number; durationMs: number }
    | { type: 'effect:stopped';     id: number };

// Compile-time check that our events extend the base shape — keeps
// reactivity honest if someone adds an event without a `type`.
type _check = ReactivityDevtoolsEvent extends DevtoolsEventBase ? true : never;
const _check: _check = true;
void _check;
