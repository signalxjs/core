/**
 * @sigx/reactivity internal APIs
 *
 * ⚠️ These are low-level primitives for building custom renderers and plugins.
 * They are NOT part of the public API and may change without notice.
 *
 * @internal
 */
export { track, trigger, cleanup } from './effect';
export { getSignalId } from './signal';

// DevTools hook surface — used by @sigx/runtime-core, @sigx/devtools,
// and any other layer that needs to emit or listen.
export {
    DEVTOOLS_HOOK_KEY,
    getDevtoolsHook,
    ensureDevtoolsHook,
    withoutOwnerTracking,
    getReactiveById,
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
