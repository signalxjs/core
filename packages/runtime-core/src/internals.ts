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

// Renderer utilities
export { createPropsAccessor } from './utils/props-accessor.js';
export { createSlots } from './utils/slots.js';
export type { InternalSlotsObject } from './utils/slots.js';
export { normalizeSubTree } from './utils/normalize.js';

// Platform bridge
export { setPlatformModelProcessor, getPlatformModelProcessor } from './platform.js';
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

// Model internals
export { getModelSymbol } from './model.js';

// Directive internals
export { __DIRECTIVE__ } from './directives.js';

// Lazy loading internals
export { registerPendingPromise } from './lazy.js';

// Hydration utilities (for SSR)
export {
    filterClientDirectives,
    getHydrationDirective,
    hasClientDirective,
    serializeProps,
    createEmit
} from './hydration/index.js';

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
