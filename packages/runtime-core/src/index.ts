// ============================================================================
// Runtime Core Package — Public API
// ============================================================================

// Platform types (public type only)
export type { ModelProcessor } from './platform.js';

// Plugin types (public type only)
export type { ComponentPlugin } from './plugins.js';

// App system
export { defineApp } from './app.js';
export type {
    AppConfig,
    AppLifecycleHooks,
    AppContext,
    Plugin,
    PluginInstallFn,
    MountFn,
    UnmountFn,
    App
} from './app.js';

// Component system
export {
    getCurrentInstance,
    component,
    onMounted,
    onUnmounted,
    onCreated,
    onUpdated,
    getComponentMeta
} from './component.js';
export type {
    ComponentAttributeExtensions,
    Define,
    DefineProp,
    ModelBinding,
    DefineModel,
    EventDefinition,
    DefineEvent,
    DefineSlot,
    SlotsObject,
    EmitFn,
    PlatformTypes,
    PlatformElement,
    MountContext,
    SetupContext,
    PropsWithDefaults,
    PropsAccessor,
    ComponentSetupContext,
    ViewFn,
    SetupFn,
    ComponentFactory,
    AnyComponentFactory,
    ComponentOptions,
    DefineExpose,
    Ref,
    Exposed,
    ComponentRef
} from './component.js';
export * from './compound.js';

// JSX runtime (selective — excludes internal platform processor re-exports)
export { jsx, jsxs, jsxDEV, Fragment, Text, Comment } from './jsx-runtime.js';
export type { VNode, JSXChild, JSXChildren, JSXElement } from './jsx-runtime.js';

// Lazy loading & Suspense
export { lazy, Suspense, isLazyComponent } from './lazy.js';
export type { LazyComponentFactory, SuspenseProps } from './lazy.js';

// Async composable
export { useAsync } from './use-async.js';
export type { AsyncState } from './use-async.js';

// Model (two-way binding)
export { createModel, createModelFromBinding, isModel } from './model.js';
export type { Model, ModelBindingTuple } from './model.js';

// Error handling
export { ErrorBoundary } from './error-boundary.js';

// Error codes
export { SigxError, SigxErrorCode } from './errors.js';
export {
    noMountFunctionError,
    renderTargetNotFoundError,
    mountTargetNotFoundError,
    asyncSetupClientError,
    provideOutsideSetupError,
    provideInvalidInjectableError,
} from './errors.js';

// Utilities
export { Utils } from './utils/index.js';

// Domain models & messaging
export * from './models/index.js';
export * from './messaging/index.js';

// Dependency injection
export { defineInjectable, defineProvide, useAppContext } from './di/injectable.js';
export type { InjectableFunction } from './di/injectable.js';
export * from './di/factory.js';

// Directives
export { defineDirective, isDirective } from './directives.js';
export type { DirectiveBinding, DirectiveDefinition, DirectiveDefinitionExtensions, ResolvedDirective } from './directives.js';

// JSX type augmentation
import './jsx-types.d.ts';

// Re-export signal from reactivity for convenience
export { signal } from '@sigx/reactivity';

// Component type guard
export { isComponent } from './renderer.js';

// Hydration types (public)
export { CLIENT_DIRECTIVE_PREFIX, CLIENT_DIRECTIVES } from './hydration/index.js';
export type { ClientDirective, HydrationStrategy, HydrationDirective } from './hydration/index.js';
