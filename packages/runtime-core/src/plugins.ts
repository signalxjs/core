/**
 * Component plugin registry for runtime-core.
 * 
 * This module has NO IMPORTS to ensure it's fully initialized before
 * any other module can import from it. This avoids circular dependency
 * issues with ES module initialization.
 */

/**
 * Plugin system for components (used by HMR, DevTools, SSR, etc.)
 * Note: SetupFn type is duplicated here to avoid circular imports
 */
export type ComponentPlugin = {
    onDefine?: (name: string | undefined, factory: Function, setup: Function) => void;
};

const plugins: ComponentPlugin[] = [];

export function registerComponentPlugin(plugin: ComponentPlugin): void {
    plugins.push(plugin);
}

/**
 * Get all registered plugins (internal use)
 */
export function getComponentPlugins(): readonly ComponentPlugin[] {
    return plugins;
}

/**
 * Context extension system for adding properties to ComponentSetupContext
 * Used by SSR, DevTools, and other packages that need to extend the context
 */
type ContextExtension = (ctx: object) => void;
const contextExtensions: ContextExtension[] = [];

/**
 * Register a function that will be called to extend every component context.
 * Extensions are called in order of registration.
 * 
 * @example
 * ```ts
 * // In @sigx/server-renderer/client
 * registerContextExtension((ctx) => {
 *     ctx.ssr = { load: () => {} };
 * });
 * ```
 */
export function registerContextExtension(extension: ContextExtension): void {
    contextExtensions.push(extension);
}

/**
 * Apply all registered context extensions to a context object.
 * Called internally by the renderer when creating component contexts.
 */
export function applyContextExtensions(ctx: object): void {
    for (const extension of contextExtensions) {
        extension(ctx);
    }
}
