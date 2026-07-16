// ============================================================================
// Runtime Core Package — Public API
// ============================================================================

// Platform types (public type only)
export type { ModelProcessor } from './platform.js';
export { registerModelProcessor } from './platform.js';

// Model modifiers (pluggable, cross-platform value-transform / timing primitive)
export { registerModelModifier } from './model-modifiers.js';
export type {
    ModelModifierDef,
    ModelModifierContext,
    ModelModifierTiming,
    ModelModifiers,
    ToggleModelModifiers,
    ValueModelModifiers,
    TimingModelModifiers,
} from './model-modifiers.js';

// Plugin types (public type only)
export type { ComponentPlugin } from './plugins.js';

// Internal — exposed for HMR runtime. Not part of the public API.
export { registerComponentPlugin as __registerComponentPlugin } from './plugins.js';

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
    ModelBinding,
    EventDefinition,
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
    Ref,
    Exposed,
    ComponentRef
} from './component.js';
export * from './compound.js';

// JSX runtime (selective — excludes internal platform processor re-exports)
export { jsx, jsxs, jsxDEV, Fragment, Text, Comment } from './jsx-runtime.js';
export type { VNode, JSXChild, JSXChildren, JSXElement } from './jsx-runtime.js';

// Lazy loading & <Defer>
export { lazy, isLazyComponent } from './lazy.js';
export type { LazyComponentFactory } from './lazy.js';
export { Defer } from './defer.js';
export type { DeferProps } from './defer.js';

// Value-first async — reads, writes, composition (docs/rfc-async.md)
export { useData } from './use-data.js';
export type { AsyncState, AsyncOptions, AsyncFetcherContext, Fetcher, MatchArms, KeyValue, KeyTuple, Falsy } from './use-data.js';
export { useAction, SupersededError } from './use-action.js';
export type { AsyncAction, ActionOptions, RunResult } from './use-action.js';
export { all } from './all.js';
export type { AllState } from './all.js';
export { useStream } from './use-stream.js';

// Model (two-way binding)
export { createModel, createModelFromBinding, isModel } from './model.js';
export type { Model, ModelBindingTuple } from './model.js';

// Error handling
export { errorScope } from './error-scope.js';
export type { ErrorScopeOptions } from './error-scope.js';

// Error codes
export { SigxError, SigxErrorCode } from './errors.js';
export {
    noMountFunctionError,
    renderTargetNotFoundError,
    mountTargetNotFoundError,
    asyncSetupClientError,
    errorScopeOutsideSetupError,
    provideOutsideSetupError,
    provideInvalidInjectableError,
    requiredInjectableNotProvidedError,
} from './errors.js';

// Utilities
export { Utils, isPromise } from './utils/index.js';

// Domain models & messaging
export * from './models/index.js';
export * from './messaging/index.js';

// Dependency injection
export { defineInjectable, defineProvide, useAppContext } from './di/injectable.js';
export type { InjectableFunction, Providable } from './di/injectable.js';
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

