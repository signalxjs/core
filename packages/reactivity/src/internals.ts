/**
 * @sigx/reactivity internal APIs
 *
 * ⚠️ These are low-level primitives for building custom renderers and plugins.
 * They are NOT part of the public API and may change without notice.
 *
 * @internal
 */
export { track, trigger, cleanup, setFlushHandler, collectSetupScope, takeSetupDisposers } from './effect';
export { getSignalId } from './signal';

// Duplicate-copy guard (rfc-1.0 §3.4). `@sigx/runtime-core` stamps its own
// seam through the same writer; `readCopyStamp` is the one accessor for both.
export { assertSingleCopy, readCopyStamp } from './copy-guard';
export type { CopyStamp, CopyStampKey } from './copy-guard';

// The deep-watch traversal, for a caller that needs the dirty signal but not
// `watch` — `@sigx/actors` drives it from a scheduler-deferred `effect` so the
// walk folds once per turn boundary instead of once per mutation, and
// `WatchOptions` has no scheduler (#651). Named `deepTrack` here because
// "traverse" says what it does and not what it is for: subscribing the active
// effect, which is the entire point of calling it.
export { traverse as deepTrack } from './watch';

// DevTools hook surface — used by @sigx/runtime-core, @sigx/devtools,
// and any other layer that needs to emit or listen.
export {
    DEVTOOLS_HOOK_KEY,
    getDevtoolsHook,
    ensureDevtoolsHook,
    withoutOwnerTracking,
    getReactiveById,
    notifySignalUpdated,
} from './devtools-hook';
export type {
    DevtoolsHook,
    DevtoolsEventBase,
    DevtoolsListenerBase,
} from './devtools-hook';
export type {
    ReactivityDevtoolsEvent,
    ReactivityKind,
} from './devtools-events';
