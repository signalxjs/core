/**
 * SSR Context — tracks component boundaries and rendering state.
 *
 * This is the core SSR context, free of any strategy-specific logic (islands, etc.).
 * Plugins extend it via the generic `_pluginData` map.
 */

import type { SSRPlugin } from '../plugin';

/**
 * Core-managed pending async component.
 * Created by render-core when streaming mode is active and no plugin overrides.
 */
export interface CorePendingAsync {
    /** Component ID */
    id: number;
    /** Resolves to rendered HTML when ssr.load() completes */
    promise: Promise<string>;
}

export interface SSRContextOptions {
    /**
     * Enable streaming mode (default: true)
     */
    streaming?: boolean;

    /**
     * Called when a component's setup() throws during SSR.
     *
     * Return a fallback HTML string to render in place of the failed component,
     * or `null` to use the default error placeholder.
     *
     * @param error - The error thrown during rendering
     * @param componentName - The component's `__name` (or 'Anonymous')
     * @param componentId - The numeric component ID assigned by the SSR context
     */
    onComponentError?: (error: Error, componentName: string, componentId: number) => string | null;
}

export interface RenderOptions {
    /**
     * Custom SSR context (created automatically if not provided)
     */
    context?: SSRContext;
}

export interface SSRContext {
    /**
     * Unique ID counter for component markers
     */
    _componentId: number;

    /**
     * Stack of component IDs for nested tracking
     */
    _componentStack: number[];

    /**
     * Collected head elements (scripts, styles, etc.)
     */
    _head: string[];

    /**
     * Error callback for component rendering failures
     */
    _onComponentError?: (error: Error, componentName: string, componentId: number) => string | null;

    /**
     * Registered SSR plugins
     */
    _plugins?: SSRPlugin[];

    /**
     * Plugin-specific data storage, keyed by plugin name.
     * Plugins store their own state here via `getPluginData` / `setPluginData`.
     */
    _pluginData: Map<string, any>;

    /**
     * Whether streaming mode is active.
     * When true, async components default to streaming (placeholder + deferred render)
     * instead of blocking. Set by renderStream / renderStreamWithCallbacks.
     */
    _streaming: boolean;

    /**
     * Core-managed pending async components.
     * Populated by render-core when async components are streamed without a plugin override.
     */
    _pendingAsync: CorePendingAsync[];

    /**
     * Generate next component ID
     */
    nextId(): number;

    /**
     * Push a component onto the stack
     */
    pushComponent(id: number): void;

    /**
     * Pop the current component from stack
     */
    popComponent(): number | undefined;

    /**
     * Add a head element
     */
    addHead(html: string): void;

    /**
     * Get collected head HTML
     */
    getHead(): string;

    /**
     * Get plugin-specific data by plugin name.
     */
    getPluginData<T>(pluginName: string): T | undefined;

    /**
     * Set plugin-specific data by plugin name.
     */
    setPluginData<T>(pluginName: string, data: T): void;
}

/**
 * Create a new SSR context for rendering
 */
export function createSSRContext(options: SSRContextOptions = {}): SSRContext {
    let componentId = 0;
    const componentStack: number[] = [];
    const head: string[] = [];
    const pluginData = new Map<string, any>();

    return {
        _componentId: componentId,
        _componentStack: componentStack,
        _head: head,
        _pluginData: pluginData,
        _onComponentError: options.onComponentError,
        _streaming: false,
        _pendingAsync: [],

        nextId() {
            return ++componentId;
        },

        pushComponent(id: number) {
            componentStack.push(id);
        },

        popComponent() {
            return componentStack.pop();
        },

        addHead(html: string) {
            head.push(html);
        },

        getHead() {
            return head.join('\n');
        },

        getPluginData<T>(pluginName: string): T | undefined {
            return pluginData.get(pluginName);
        },

        setPluginData<T>(pluginName: string, data: T): void {
            pluginData.set(pluginName, data);
        }
    };
}
