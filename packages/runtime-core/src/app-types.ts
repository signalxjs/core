/**
 * Type definitions for the sigx application and plugin system.
 * 
 * This file contains only type definitions with no runtime code,
 * ensuring clean type isolation and avoiding circular dependencies.
 */

import type { VNode, JSXElement } from './jsx-runtime.js';
import type { ComponentSetupContext } from './component.js';
import type { InjectableFunction } from './di/injectable.js';
import type { DirectiveDefinition } from './directives.js';

// ============================================================================
// Component Instance
// ============================================================================

/**
 * Component instance info passed to lifecycle hooks.
 * This is renderer-agnostic - works with DOM, Terminal, or any platform.
 */
export interface ComponentInstance {
    /** Component name (if defined via component options) */
    name?: string;
    /** The component's setup context with props, slots, emit, etc. */
    ctx: ComponentSetupContext;
    /** The component's virtual node */
    vnode: VNode;
}

// ============================================================================
// App Configuration
// ============================================================================

/**
 * App-level configuration
 */
export interface AppConfig {
    /**
     * Global error handler for component errors.
     * Return true to suppress the error from propagating.
     */
    errorHandler?: (err: Error, instance: ComponentInstance | null, info: string) => boolean | void;

    /**
     * Global warning handler (dev mode).
     */
    warnHandler?: (msg: string, instance: ComponentInstance | null, trace: string) => void;

    /**
     * Performance tracking hook - called when a component renders
     */
    performance?: boolean;
}

// ============================================================================
// Lifecycle Hooks
// ============================================================================

/**
 * App lifecycle hooks that plugins can use to observe all components
 */
export interface AppLifecycleHooks {
    /**
     * Called when a component's setup function completes
     */
    onComponentCreated?: (instance: ComponentInstance) => void;

    /**
     * Called after a component is mounted to the platform (DOM, terminal, etc.)
     */
    onComponentMounted?: (instance: ComponentInstance) => void;

    /**
     * Called before a component is unmounted
     */
    onComponentUnmounted?: (instance: ComponentInstance) => void;

    /**
     * Called when a component's render function runs (re-render)
     */
    onComponentUpdated?: (instance: ComponentInstance) => void;

    /**
     * Called when an error occurs in a component.
     * Return true to suppress the error from propagating.
     */
    onComponentError?: (err: Error, instance: ComponentInstance, info: string) => boolean | void;
}

// ============================================================================
// App Context
// ============================================================================

/**
 * App context that gets passed through the component tree.
 * Used internally by renderers to propagate app-level state.
 */
export interface AppContext {
    /** The app instance */
    app: App;
    /** App-level provides (available via inject in all components) */
    provides: Map<symbol, unknown>;
    /** App configuration */
    config: AppConfig;
    /** Lifecycle hooks from all plugins */
    hooks: AppLifecycleHooks[];
    /** Registered directives */
    directives: Map<string, DirectiveDefinition>;
}

// ============================================================================
// Plugin System
// ============================================================================

/**
 * Plugin interface - plugins implement install() to configure the app.
 * 
 * @example
 * ```typescript
 * const useMyService = defineInjectable(() => new MyService());
 * 
 * const myPlugin: Plugin<{ debug?: boolean }> = {
 *     name: 'my-plugin',
 *     install(app, options) {
 *         app.defineProvide(useMyService);
 *         app.hook({
 *             onComponentMounted: (instance) => {
 *                 if (options?.debug) console.log('Mounted:', instance.name);
 *             }
 *         });
 *     }
 * };
 * ```
 */
export interface Plugin<Options = any> {
    /**
     * Plugin name for debugging
     */
    name?: string;

    /**
     * Called when plugin is installed via app.use()
     */
    install(app: App, options?: Options): void;
}

/**
 * Function-style plugin (simpler alternative to object plugins)
 * 
 * @example
 * ```typescript
 * const useLogger = defineInjectable(() => createLogger());
 * 
 * const simplePlugin: PluginInstallFn = (app) => {
 *     app.defineProvide(useLogger);
 * };
 * ```
 */
export type PluginInstallFn<Options = any> = (app: App, options?: Options) => void;

// ============================================================================
// Mount/Unmount Functions
// ============================================================================

/**
 * Mount function signature - implemented by platform renderers.
 * Each platform (DOM, Terminal, etc.) provides their own mount function.
 * 
 * @param element - The root component/element to render
 * @param container - Platform-specific container (HTMLElement, terminal options, etc.)
 * @param appContext - The app context for DI and lifecycle hooks
 * @returns Optional cleanup/unmount function
 * 
 * @example
 * ```typescript
 * // DOM platform provides:
 * export const domMount: MountFn<HTMLElement> = (element, container, appContext) => {
 *     render(element, container, appContext);
 *     return () => { /* cleanup *\/ };
 * };
 * 
 * // Terminal platform provides:
 * export const terminalMount: MountFn<TerminalOptions> = (element, options, appContext) => {
 *     return renderTerminal(element, options, appContext);
 * };
 * ```
 */
export type MountFn<TContainer = any> = (
    element: JSXElement,
    container: TContainer,
    appContext: AppContext
) => (() => void) | void;

/**
 * Unmount function signature - provided by platform renderers
 */
export type UnmountFn<TContainer = any> = (container: TContainer) => void;

// ============================================================================
// App Instance
// ============================================================================

/**
 * The App instance returned by defineApp().
 * Provides a chainable API for configuring and mounting the application.
 * 
 * @example
 * ```tsx
 * const app = defineApp(<App />);
 * 
 * // Using with defineInjectable tokens
 * const useConfig = defineInjectable(() => ({ apiUrl: 'https://...' }));
 * const config = app.defineProvide(useConfig);
 * config.apiUrl = 'https://custom.api.com';
 * 
 * app.use(routerPlugin)
 *    .mount(document.getElementById('app')!);
 * ```
 */
export interface App<TContainer = any> {
    /**
     * App configuration (error handlers, etc.)
     */
    config: AppConfig;

    /**
     * Install a plugin. Plugins are only installed once.
     */
    use<Options>(plugin: Plugin<Options> | PluginInstallFn<Options>, options?: Options): App<TContainer>;

    /**
     * Provide a new instance of an injectable at app level.
     * All components will receive this instance when calling the injectable function.
     * 
     * @param useFn - An injectable function created by defineInjectable
     * @param factory - Optional custom factory. If not provided, uses the injectable's default factory.
     * @returns The created instance
     * 
     * @example
     * ```typescript
     * const useApiConfig = defineInjectable(() => ({ baseUrl: 'https://api.example.com' }));
     * 
     * const app = defineApp(<App />);
     * 
     * // Use default factory
     * const config = app.defineProvide(useApiConfig);
     * config.baseUrl = 'https://custom.api.com';
     * 
     * // Or provide custom factory
     * app.defineProvide(useApiConfig, () => ({ baseUrl: 'https://other.api.com' }));
     * ```
     */
    defineProvide<T>(useFn: InjectableFunction<T>, factory?: () => T): T;

    /**
     * Register lifecycle hooks to observe all components
     */
    hook(hooks: AppLifecycleHooks): App<TContainer>;

    /**
     * Register a global directive, or retrieve a registered one.
     *
     * @example
     * ```typescript
     * // Register
     * app.directive('tooltip', {
     *     mounted(el, { value }) { el.title = value; },
     *     updated(el, { value }) { el.title = value; }
     * });
     *
     * // Retrieve
     * const dir = app.directive('tooltip');
     * ```
     */
    directive(name: string, definition: DirectiveDefinition): App<TContainer>;
    directive(name: string): DirectiveDefinition | undefined;

    /**
     * Mount the app to a container.
     * 
     * If a mount function is not provided, the platform's default mount function
     * will be used (set via setDefaultMount by the active platform package).
     * 
     * @example
     * ```tsx
     * // Simple usage (uses platform default)
     * app.mount(document.getElementById('app')!);
     * 
     * // Explicit mount function
     * import { domMount } from '@sigx/runtime-dom';
     * app.mount(document.getElementById('app')!, domMount);
     * ```
     */
    mount(container: TContainer, mountFn?: MountFn<TContainer>): App<TContainer>;

    /**
     * Unmount the app and clean up resources
     */
    unmount(): void;

    /**
     * Get the app context (for internal use by renderers)
     * @internal
     */
    _context: AppContext;

    /**
     * Check if the app is mounted
     * @internal
     */
    _isMounted: boolean;

    /**
     * The container where the app is mounted
     * @internal
     */
    _container: TContainer | null;

    /**
     * The root component passed to defineApp()
     * @internal
     */
    _rootComponent: JSXElement;
}
