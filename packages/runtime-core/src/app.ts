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
    AppConfig,
    AppContext,
    Plugin,
    PluginInstallFn,
    MountFn,
    App
} from './app-types.js';

import { getAppContextToken, type InjectableFunction } from './di/injectable.js';
import { isDirective } from './directives.js';
import type { JSXElement } from './jsx-runtime.js';
import { noMountFunctionError, provideInvalidInjectableError } from './errors.js';

// ============================================================================
// Dev mode flag - must be at top before any usage
// ============================================================================

const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production' || true;

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
        config: {},
        hooks: [],
        directives: new Map()
    };

    let isMounted = false;
    let container: TContainer | null = null;
    let unmountFn: (() => void) | null = null;

    const app: App<TContainer> = {
        config: context.config,

        use(plugin, options) {
            if (installedPlugins.has(plugin)) {
                // Plugin already installed, skip
                if (isDev) {
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
            } else if (isDev) {
                console.warn('Invalid plugin: must be a function or have an install() method.');
            }

            return app;
        },

        defineProvide<T>(useFn: InjectableFunction<T>, factory?: () => T): T {
            const actualFactory = factory ?? useFn._factory;
            const token = useFn._token;

            if (!actualFactory || !token) {
                throw provideInvalidInjectableError();
            }

            const instance = actualFactory();
            context.provides.set(token, instance);
            return instance;
        },

        hook(hooks) {
            context.hooks.push(hooks);
            return app;
        },

        directive(name: string, definition?: any): any {
            if (definition !== undefined) {
                if (isDev && !isDirective(definition)) {
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
                if (isDev) {
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
                if (isDev) {
                    console.warn('App is not mounted.');
                }
                return;
            }

            if (unmountFn) {
                unmountFn();
            }

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
}

/**
 * Handle an error in a component. Returns true if the error was handled.
 * Called by the renderer when an error occurs in setup or render.
 */
export function handleComponentError(
    context: AppContext | null,
    err: Error,
    instance: ComponentInstance | null,
    info: string
): boolean {
    if (!context) return false;

    // First, try plugin hooks
    for (const hooks of context.hooks) {
        try {
            const handled = hooks.onComponentError?.(err, instance!, info);
            if (handled === true) return true;
        } catch (hookErr) {
            // Hook itself threw - log and continue
            console.error('Error in onComponentError hook:', hookErr);
        }
    }

    // Then, try app-level error handler
    if (context.config.errorHandler) {
        try {
            const handled = context.config.errorHandler(err, instance, info);
            if (handled === true) return true;
        } catch (handlerErr) {
            console.error('Error in app.config.errorHandler:', handlerErr);
        }
    }

    return false;
}

/**
 * Handle errors that occur in hooks themselves
 */
function handleHookError(context: AppContext, err: Error, instance: ComponentInstance, hookName: string): void {
    console.error(`Error in ${hookName} hook:`, err);

    // Try the app error handler
    if (context.config.errorHandler) {
        try {
            context.config.errorHandler(err, instance, `plugin hook: ${hookName}`);
        } catch {
            // Give up - we've done our best
        }
    }
}
