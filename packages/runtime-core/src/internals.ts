/**
 * @sigx/runtime-core internal APIs
 * 
 * ⚠️ These are low-level primitives for building custom renderers, SSR plugins,
 * and framework extensions. They are NOT part of the public API and may change
 * without notice.
 * 
 * @internal
 */

// Renderer creation (for platform renderers, e.g. @sigx/runtime-dom)
export { createRenderer } from './renderer.js';
export type {
    RendererOptions,
    Renderer,
    RootRenderFunction,
    RendererMountFn,
    RendererUnmountFn,
    RendererPatchFn,
    RendererMountComponentFn,
    InternalVNode
} from './renderer.js';

// Component internals (for renderers and SSR)
export { setCurrentInstance, getCurrentInstance } from './component.js';
export type { SetupFn, ViewFn, ComponentSetupContext, SlotsObject } from './component.js';

// Render scheduler (one job per component, parent-before-child flush)
export { queueJob, flushJobs, nextJobId } from './scheduler.js';
export type { SchedulerJob } from './scheduler.js';

// Renderer utilities
export { createPropsAccessor } from './utils/props-accessor.js';
export { createSlots, invokeFunctionChildren } from './utils/slots.js';
export type { InternalSlotsObject } from './utils/slots.js';
export { normalizeSubTree } from './utils/normalize.js';

// Platform bridge
export { setPlatformModelProcessor, getPlatformModelProcessor, registerModelProcessor, getModelProcessors } from './platform.js';

// Model modifier internals (for platform renderers — DOM, Lynx)
export {
    registerModelModifier,
    getModelModifier,
    applyModelTransforms,
    resolveTiming,
    wrapModelWriteBack,
    getHandlerModifiers,
    createDebounceScheduler,
} from './model-modifiers.js';
export type { ResolvedTiming, DebounceScheduler } from './model-modifiers.js';
export { setDefaultMount, getDefaultMount } from './app.js';

// Plugin system internals
export {
    notifyComponentCreated,
    notifyComponentMounted,
    notifyComponentUnmounted,
    notifyComponentUpdated,
    handleComponentError
} from './app.js';
export type { ComponentInstance } from './app.js';
export { getComponentPlugins, applyContextExtensions, registerComponentPlugin, registerContextExtension } from './plugins.js';

// DI internals
export { getAppContextToken, provideAppContext } from './di/injectable.js';
// Typed seam tokens: create + read/write helpers that carry the value type,
// so seam reads need no `as X | undefined` casts
export { createToken, getProvided, setProvided, hasForeignToken } from './di/token.js';
export type { InjectionToken } from './di/token.js';

// Async engine internals (for server renderers and cache packs)
export { matchAsyncState, registerHandledAsyncOptionKeys, makeUnhandledReporter, normalizeError, makeAbortController, inertAbortSignal } from './async/shared.js';
export { reportUnhandledAsyncError } from './app.js';
// The `__SIGX_ASYNC__` page-blob accessors — THE decode point for that seam
// (docs/seams.md). Exported so `@sigx/cache` reads the blob through the same
// functions instead of re-implementing them; a second copy meant a second
// place to apply the codec, and the decode was already missed once.
export { peekRestored, invalidateRestored, writeBack, reviveFromServer } from './async/restore.js';
// Live-client declaration (for non-web platform-identity modules — lynx/terminal;
// NOT for @sigx/runtime-dom/platform, which SSR also evaluates)
export { declareLiveClient, isLiveClient } from './async/environment.js';
// The §7 pack contract: per-app engine swap + the default engine to delegate to
export { ASYNC_ENGINE_TOKEN, provideAsyncEngine, defaultAsyncEngine } from './async/engine.js';
export type { AsyncEngine, AsyncReadHandle } from './async/engine.js';

// SSR serializer type-handler seam (per-app provide, consumed by @sigx/server-renderer)
export { TYPE_HANDLER_TOKEN, provideTypeHandlers } from './ssr-serialize.js';
// Re-exported for convenience: consumers that already depend on runtime-core
// (server-renderer, resume, cache) get the codec without a second import.
// `@sigx/server` deliberately imports `@sigx/serialize` directly instead —
// its client stub must not pull runtime-core.
export {
    BUILTIN_TYPE_HANDLERS,
    defineTypeHandler,
    encodeWithHandlers,
    reviveWithHandlers,
} from '@sigx/serialize';
export type { TypeHandler } from '@sigx/serialize';

// errorScope internals (for the SSR hydrator: render wrapping + server-error seeding)
export { applyErrorScope, seedErrorScopeError, ERROR_SCOPE_TOKEN } from './error-scope.js';
export type { ErrorScopeHandle } from './error-scope.js';

// Model internals
export { getModelSymbol } from './model.js';

// Directive internals
export { __DIRECTIVE__ } from './directives.js';

// Component-setup helpers shared with the client hydrator
export { createEmit, splitComponentProps } from './utils/component-props.js';

// Prod error-code helper: build a `SIGX### — see <url>` SigxError for first-party
// packs that throw coded errors (used by @sigx/server-renderer). Packs whose site
// isn't a throw, or that can't depend on runtime-core, inline the code instead.
export { prodError } from './errors.js';

// Async context (for SSR isolation)
export { runInRequestScope, hasRequestIsolation } from './async-context.js';

// DevTools hook (for @sigx/devtools and other inspectors)
export {
    DEVTOOLS_HOOK_KEY,
    getDevtoolsHook,
    ensureDevtoolsHook
} from './devtools-hook.js';
export type {
    DevtoolsHook,
    DevtoolsEvent,
    DevtoolsListener
} from './devtools-hook.js';
