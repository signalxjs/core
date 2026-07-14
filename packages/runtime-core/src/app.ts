/**
 * Application instance and plugin system for sigx.
 * 
 * This module provides a renderer-agnostic way to configure and bootstrap
 * sigx applications with plugins, dependency injection, and lifecycle hooks.
 */

// Re-export all types from the types file
export type {
    ComponentInstance,
    AppConfig,
    AppLifecycleHooks,
    AppContext,
    Plugin,
    PluginInstallFn,
    MountFn,
    UnmountFn,
    App
} from './app-types.js';

// Import types for internal use
import type {
    ComponentInstance,
    AppContext,
    Plugin,
    PluginInstallFn,
    MountFn,
    App
} from './app-types.js';

import { getAppContextToken, setActiveAppContext, type Providable } from './di/injectable.js';
import { ERROR_SCOPE_TOKEN, type ErrorScopeHandle } from './error-scope.js';
import { isDirective } from './directives.js';
import { isPromise } from './utils/index.js';
import type { JSXElement } from './jsx-runtime.js';
import { noMountFunctionError, provideInvalidInjectableError } from './errors.js';
import { getDevtoolsHook } from './devtools-hook.js';
import { getInstanceId, getParentInstanceId } from './component-lifecycle.js';

// ============================================================================
// Constants
// ============================================================================

// AppContextKey is no longer needed - we use the DI system's token

// ============================================================================
// Default Mount Function (set by platform packages)
// ============================================================================

let defaultMountFn: MountFn<any> | null = null;

/**
 * Set the default mount function for the platform.
 * Called by platform packages on import.
 * 
 * @example
 * ```typescript
 * // In @sigx/runtime-dom
 * import { setDefaultMount } from '@sigx/runtime-core';
 * setDefaultMount(domMount);
 * ```
 */
export function setDefaultMount<TContainer = any>(mountFn: MountFn<TContainer>): void {
    defaultMountFn = mountFn;
}

/**
 * Get the current default mount function.
 * @internal
 */
export function getDefaultMount(): MountFn<any> | null {
    return defaultMountFn;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an application instance.
 * 
 * @example
 * ```tsx
 * import { defineApp, defineInjectable } from '@sigx/runtime-core';
 * 
 * // Define an injectable service
 * const useApiConfig = defineInjectable(() => ({ baseUrl: 'https://api.example.com' }));
 * 
 * const app = defineApp(<App />);
 * 
 * app.use(myPlugin, { option: 'value' });
 * 
 * // Provide custom instance at app level
 * const config = app.defineProvide(useApiConfig);
 * config.baseUrl = 'https://custom.api.com';
 * 
 * app.mount(document.getElementById('app')!);
 * ```
 */
export function defineApp<TContainer = any>(rootComponent: JSXElement): App<TContainer> {
    const installedPlugins = new Set<Plugin | PluginInstallFn>();

    const context: AppContext = {
        app: null!, // Will be set below
        provides: new Map(),
        disposables: new Set(),
        config: {},
        hooks: [],
        directives: new Map()
    };

    let isMounted = false;
    let container: TContainer | null = null;
    let unmountFn: (() => void) | null = null;
    // Dev-only: warn once per app when runWithContext gets an async callback.
    let warnedAsyncRunWithContext = false;

    const app: App<TContainer> = {
        config: context.config,

        use(plugin, options) {
            if (installedPlugins.has(plugin)) {
                // Plugin already installed, skip
                if (process.env.NODE_ENV !== 'production') {
                    console.warn(`Plugin ${(plugin as Plugin).name || 'anonymous'} is already installed.`);
                }
                return app;
            }

            installedPlugins.add(plugin);

            if (typeof plugin === 'function') {
                // Function-style plugin
                plugin(app, options);
            } else if (plugin && typeof plugin.install === 'function') {
                // Object-style plugin
                plugin.install(app, options);
            } else if (process.env.NODE_ENV !== 'production') {
                console.warn('Invalid plugin: must be a function or have an install() method.');
            }

            return app;
        },

        defineProvide<T>(useFn: Providable<T>, factory?: () => T): T {
            const actualFactory = factory ?? useFn._factory;
            const token = useFn._token;

            if (!actualFactory || !token) {
                throw provideInvalidInjectableError();
            }

            const instance = actualFactory();
            context.provides.set(token, instance);
            // App-provided instances are app-owned: dispose them on unmount —
            // unless the factory setup took over disposal via overrideDispose.
            // Factory-generated disposes are stored RAW so the factory's
            // dispose/recreate logic can delete the stale entry; user-supplied
            // method-style disposes get a bound wrapper so `this` survives.
            const dispose = (instance as { dispose?: unknown } | null)?.dispose;
            if (typeof dispose === 'function'
                && (dispose as { __sigxCustomManaged?: boolean }).__sigxCustomManaged !== true) {
                const isFactoryDispose = '__sigxDisposed' in (dispose as object);
                context.disposables.add(
                    isFactoryDispose
                        ? dispose as () => void
                        : () => (dispose as () => void).call(instance)
                );
            }
            return instance;
        },

        runWithContext<T>(fn: () => T): T {
            // Make this app's context the active fallback for DI resolution
            // outside components (router guards, socket handlers, entry-scope
            // code). Synchronous only: restored in finally, so the context
            // never leaks past the first await of an async fn. Nested calls
            // restore the previous context. (Async continuation support via
            // AsyncLocalStorage was considered and deferred: browsers have no
            // ALS, so it would silently split state client-side — revisit
            // when TC39 AsyncContext is available cross-platform.)
            const prev = setActiveAppContext(context);
            try {
                const result = fn();
                if (process.env.NODE_ENV !== 'production'
                    && !warnedAsyncRunWithContext
                    && isPromise(result)) {
                    warnedAsyncRunWithContext = true;
                    console.warn(
                        'app.runWithContext(fn) got a callback that returned a Promise (or ' +
                        'other thenable) — the app context applies only to its synchronous ' +
                        'portion and is restored before any awaited continuation runs. After ' +
                        'an await, re-enter with another runWithContext call to resolve more ' +
                        'dependencies.'
                    );
                }
                return result;
            } finally {
                setActiveAppContext(prev);
            }
        },

        hook(hooks) {
            context.hooks.push(hooks);
            return app;
        },

        onError(handler) {
            if (process.env.NODE_ENV !== 'production' && context.config.onError) {
                console.warn(
                    'app.onError() replaces the previous handler — for multiple observers use ' +
                    'app.hook({ onComponentError }).'
                );
            }
            context.config.onError = handler;
            return app;
        },

        directive(name: string, definition?: any): any {
            if (definition !== undefined) {
                if (process.env.NODE_ENV !== 'production' && !isDirective(definition)) {
                    console.warn(
                        `[sigx] app.directive('${name}', ...) received a value that is not a valid directive definition. ` +
                        `Use defineDirective() to create directive definitions.`
                    );
                }
                context.directives.set(name, definition);
                return app;
            }
            return context.directives.get(name);
        },

        mount(target, renderFn?) {
            if (isMounted) {
                if (process.env.NODE_ENV !== 'production') {
                    console.warn('App is already mounted. Call app.unmount() first.');
                }
                return app;
            }

            // Use provided mount function or fall back to platform default
            const mountFn = renderFn ?? defaultMountFn;

            if (!mountFn) {
                throw noMountFunctionError();
            }

            container = target;
            isMounted = true;

            if (process.env.NODE_ENV !== 'production') {
                const devtools = getDevtoolsHook();
                if (devtools) {
                    devtools.apps.add(context);
                    devtools.emit({ type: 'app:init', app: context });
                }
            }

            // Call the platform-specific render function with our app context
            // The render function may return an unmount callback
            const result = mountFn(rootComponent, target, context);
            if (typeof result === 'function') {
                unmountFn = result;
            }

            return app;
        },

        unmount() {
            if (!isMounted) {
                if (process.env.NODE_ENV !== 'production') {
                    console.warn('App is not mounted.');
                }
                return;
            }

            if (unmountFn) {
                unmountFn();
            }

            if (process.env.NODE_ENV !== 'production') {
                const devtools = getDevtoolsHook();
                if (devtools) {
                    devtools.emit({ type: 'app:unmount', app: context });
                    devtools.apps.delete(context);
                }
            }

            // Dispose app-owned instances (singletons, app-level provides).
            // Each disposable is isolated so one failing dispose cannot
            // prevent the rest of the teardown.
            for (const dispose of context.disposables) {
                try {
                    dispose();
                } catch (err) {
                    console.error('Error disposing app-owned instance:', err);
                }
            }
            context.disposables.clear();

            // Clear provides to help GC
            context.provides.clear();

            isMounted = false;
            container = null;
        },

        get _context() {
            return context;
        },

        get _isMounted() {
            return isMounted;
        },

        get _container() {
            return container;
        },

        get _rootComponent() {
            return rootComponent;
        }
    };

    // Set the app reference in context
    context.app = app;

    // Provide the AppContext via the DI system
    const appContextToken = getAppContextToken();
    context.provides.set(appContextToken, context);

    return app;
}

// ============================================================================
// Hooks API - Called by renderers to notify plugins
// ============================================================================

/**
 * Notify all app hooks that a component was created.
 * Called by the renderer after setup() returns.
 */
export function notifyComponentCreated(context: AppContext | null, instance: ComponentInstance): void {
    if (!context) return;
    for (const hooks of context.hooks) {
        try {
            hooks.onComponentCreated?.(instance);
        } catch (err) {
            handleHookError(context, err as Error, instance, 'onComponentCreated');
        }
    }
    if (process.env.NODE_ENV !== 'production') {
        const devtools = getDevtoolsHook();
        if (devtools) devtools.emit({
            type: 'component:created',
            app: context,
            instance,
            instanceId: getInstanceId(instance.ctx),
            parentInstanceId: getParentInstanceId(instance.ctx),
        });
    }
}

/**
 * Notify all app hooks that a component was mounted.
 * Called by the renderer after mount hooks run.
 */
export function notifyComponentMounted(context: AppContext | null, instance: ComponentInstance): void {
    if (!context) return;
    for (const hooks of context.hooks) {
        try {
            hooks.onComponentMounted?.(instance);
        } catch (err) {
            handleHookError(context, err as Error, instance, 'onComponentMounted');
        }
    }
    if (process.env.NODE_ENV !== 'production') {
        const devtools = getDevtoolsHook();
        if (devtools) devtools.emit({ type: 'component:mounted', app: context, instance, instanceId: getInstanceId(instance.ctx) });
    }
}

/**
 * Notify all app hooks that a component was unmounted.
 * Called by the renderer before cleanup.
 */
export function notifyComponentUnmounted(context: AppContext | null, instance: ComponentInstance): void {
    if (!context) return;
    for (const hooks of context.hooks) {
        try {
            hooks.onComponentUnmounted?.(instance);
        } catch (err) {
            handleHookError(context, err as Error, instance, 'onComponentUnmounted');
        }
    }
    if (process.env.NODE_ENV !== 'production') {
        const devtools = getDevtoolsHook();
        if (devtools) devtools.emit({ type: 'component:unmounted', app: context, instance, instanceId: getInstanceId(instance.ctx) });
    }
}

/**
 * Notify all app hooks that a component updated.
 * Called by the renderer after re-render.
 */
export function notifyComponentUpdated(context: AppContext | null, instance: ComponentInstance): void {
    if (!context) return;
    for (const hooks of context.hooks) {
        try {
            hooks.onComponentUpdated?.(instance);
        } catch (err) {
            handleHookError(context, err as Error, instance, 'onComponentUpdated');
        }
    }
    if (process.env.NODE_ENV !== 'production') {
        const devtools = getDevtoolsHook();
        if (devtools) devtools.emit({ type: 'component:updated', app: context, instance, instanceId: getInstanceId(instance.ctx) });
    }
}

/**
 * Handle an error in a component. Returns true if the error was handled.
 * Called by the renderer when an error occurs in setup or render (and by
 * the DOM event path and the async bubble).
 *
 * Order: nearest errorScope (walking the instance parent chain) → plugin
 * hooks → app `onError`. Scoped recovery is local handling, like DOM event
 * bubbling — the app layer sees only what escapes every scope.
 */
export function handleComponentError(
    context: AppContext | null,
    err: Error,
    instance: ComponentInstance | null,
    info: string
): boolean {
    if (context && process.env.NODE_ENV !== 'production') {
        const devtools = getDevtoolsHook();
        if (devtools) devtools.emit({ type: 'component:error', app: context, instance, instanceId: getInstanceId(instance?.ctx ?? null), error: err, info });
    }

    // Nearest errorScope first — the walk runs even with a null app context
    // (errorScope works in a bare render() without defineApp). Event-handler
    // throws arrive with instance null, so they naturally skip to the app
    // layer. A scope that declines (already errored) lets the walk continue.
    let node = instance?.ctx as { provides?: Map<symbol, unknown>; parent?: unknown } | null | undefined;
    while (node) {
        const scope = node.provides?.get(ERROR_SCOPE_TOKEN) as ErrorScopeHandle | undefined;
        if (scope && scope.handle(err, instance, info) === true) return true;
        node = node.parent as typeof node;
    }

    if (!context) return false;

    // Then, plugin hooks
    for (const hooks of context.hooks) {
        try {
            const handled = hooks.onComponentError?.(err, instance!, info);
            if (handled === true) return true;
        } catch (hookErr) {
            // Hook itself threw - log and continue
            console.error('Error in onComponentError hook:', hookErr);
        }
    }

    // Then, the app-level onError handler
    if (context.config.onError) {
        try {
            const handled = context.config.onError(err, instance, info);
            if (handled === true) return true;
        } catch (handlerErr) {
            console.error('Error in app onError handler:', handlerErr);
        }
    }

    return false;
}

/**
 * Bubble hook for the async layer: a cell is `'errored'`, `match()` was
 * given no `error` arm, so the error escalates — nearest `errorScope`, then
 * the app `onError` handler (both via {@link handleComponentError}). Never
 * throws: `match()` runs during render, and an unhandled data error must
 * not take the component down with it.
 *
 * `ctx` is the setup-time instance captured by the cell (matching where the
 * `useData`/`useAction` call lives, regardless of which render reads it).
 *
 * @internal
 */
export function reportUnhandledAsyncError(
    err: Error,
    ctx: { provides?: Map<symbol, unknown>; parent?: unknown } | null
): boolean {
    // Resolve the owning app context by walking the provides chain from the
    // captured instance (the root component carries the AppContext token).
    const token = getAppContextToken();
    let appContext: AppContext | null = null;
    let node = ctx;
    while (node) {
        const found = node.provides?.get(token);
        if (found) {
            appContext = found as AppContext;
            break;
        }
        node = node.parent as typeof ctx;
    }

    const instance: ComponentInstance | null = ctx
        ? { name: (ctx as { __name?: string }).__name ?? 'Component', ctx: ctx as ComponentInstance['ctx'], vnode: null as unknown as ComponentInstance['vnode'] }
        : null;
    const handled = handleComponentError(appContext, err, instance, 'async');
    if (!handled) {
        console.error('[sigx] Unhandled async error:', err);
    }
    return handled;
}

/**
 * Handle errors that occur in hooks themselves
 */
function handleHookError(context: AppContext, err: Error, instance: ComponentInstance, hookName: string): void {
    console.error(`Error in ${hookName} hook:`, err);

    // Try the app onError handler
    if (context.config.onError) {
        try {
            context.config.onError(err, instance, `plugin hook: ${hookName}`);
        } catch {
            // Give up - we've done our best
        }
    }
}
