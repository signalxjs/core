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
export { createSlots } from './utils/slots.js';
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

// Async engine internals (for server renderers and cache packs)
export { matchAsyncState, registerHandledAsyncOptionKeys, makeUnhandledReporter, normalizeError, makeAbortController, inertAbortSignal } from './async/shared.js';
export { reportUnhandledAsyncError } from './app.js';
// The §7 pack contract: per-app engine swap + the default engine to delegate to
export { ASYNC_ENGINE_TOKEN, provideAsyncEngine, defaultAsyncEngine } from './async/engine.js';
export type { AsyncEngine, AsyncReadHandle } from './async/engine.js';

// SSR serializer type-handler seam (per-app provide, consumed by @sigx/server-renderer)
export { SSR_SERIALIZER_TOKEN, provideSSRSerializerHandlers } from './ssr-serialize.js';
export type { SSRTypeHandler } from './ssr-serialize.js';

// Model internals
export { getModelSymbol } from './model.js';

// Directive internals
export { __DIRECTIVE__ } from './directives.js';

// Component-setup helpers shared with the client hydrator
export { createEmit, splitComponentProps } from './utils/component-props.js';

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
