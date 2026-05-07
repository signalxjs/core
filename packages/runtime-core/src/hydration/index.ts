/**
 * Hydration utilities for SSR
 * 
 * These utilities are shared between server-side rendering (stream.ts)
 * and client-side hydration (hydrate.ts). They are placed in runtime-core
 * to allow any SSR implementation to use them.
 * 
 * @module
 */

/**
 * Client directive prefix used for selective hydration
 */
export const CLIENT_DIRECTIVE_PREFIX = 'client:';

/**
 * Valid client directive names
 */
export const CLIENT_DIRECTIVES = [
    'client:load',
    'client:idle',
    'client:visible',
    'client:media',
    'client:only'
] as const;

export type ClientDirective = typeof CLIENT_DIRECTIVES[number];

/**
 * Hydration strategies for client directives
 */
export type HydrationStrategy = 'load' | 'idle' | 'visible' | 'media' | 'only';

/**
 * Result of getHydrationDirective
 */
export interface HydrationDirective {
    strategy: HydrationStrategy;
    media?: string;
}

/**
 * Filter out client directives from props.
 * Used to get the actual component props without hydration hints.
 * 
 * @example
 * ```ts
 * const props = { 'client:visible': true, name: 'test', count: 5 };
 * filterClientDirectives(props); // { name: 'test', count: 5 }
 * ```
 */
export function filterClientDirectives(props: Record<string, any>): Record<string, any> {
    const filtered: Record<string, any> = {};
    for (const key in props) {
        if (!key.startsWith(CLIENT_DIRECTIVE_PREFIX)) {
            filtered[key] = props[key];
        }
    }
    return filtered;
}

/**
 * Get hydration directive from props.
 * Returns the strategy and optional media query for client:media.
 * 
 * @example
 * ```ts
 * getHydrationDirective({ 'client:visible': true }); // { strategy: 'visible' }
 * getHydrationDirective({ 'client:media': '(min-width: 768px)' }); // { strategy: 'media', media: '(min-width: 768px)' }
 * getHydrationDirective({ name: 'test' }); // null
 * ```
 */
export function getHydrationDirective(props: Record<string, any>): HydrationDirective | null {
    if (props['client:load'] !== undefined) return { strategy: 'load' };
    if (props['client:idle'] !== undefined) return { strategy: 'idle' };
    if (props['client:visible'] !== undefined) return { strategy: 'visible' };
    if (props['client:only'] !== undefined) return { strategy: 'only' };
    if (props['client:media'] !== undefined) {
        return { strategy: 'media', media: props['client:media'] };
    }
    return null;
}

/**
 * Check if props contain any client directive.
 * 
 * @example
 * ```ts
 * hasClientDirective({ 'client:visible': true }); // true
 * hasClientDirective({ name: 'test' }); // false
 * ```
 */
export function hasClientDirective(props: Record<string, any>): boolean {
    for (const key in props) {
        if (key.startsWith(CLIENT_DIRECTIVE_PREFIX)) {
            return true;
        }
    }
    return false;
}

/**
 * Serialize props for client hydration.
 * Filters out non-serializable values (functions, symbols, undefined).
 * Returns undefined if no serializable props remain.
 * 
 * @example
 * ```ts
 * serializeProps({ name: 'test', onClick: () => {} }); // { name: 'test' }
 * serializeProps({ onClick: () => {} }); // undefined
 * ```
 */
export function serializeProps(props: Record<string, any>): Record<string, any> | undefined {
    const filtered = filterClientDirectives(props);

    const result: Record<string, any> = {};
    let hasProps = false;

    for (const key in filtered) {
        const value = filtered[key];

        // Skip internal props
        if (key === 'children' || key === 'key' || key === 'ref' || key === 'slots') continue;

        // Skip functions (event handlers, etc.)
        if (typeof value === 'function') continue;

        // Skip symbols
        if (typeof value === 'symbol') continue;

        // Skip undefined values
        if (value === undefined) continue;

        // Skip event handlers (on* props)
        if (key.startsWith('on') && key.length > 2 && key[2] === key[2].toUpperCase()) continue;

        // Try to serialize - skip if fails
        try {
            JSON.stringify(value);
            result[key] = value;
            hasProps = true;
        } catch {
            // Non-serializable, skip
        }
    }

    return hasProps ? result : undefined;
}

/**
 * Create an emit function for component context.
 * This is a common pattern used in both mountComponent and hydrateComponent.
 * 
 * @example
 * ```ts
 * const emit = createEmit(reactiveProps);
 * emit('click', eventData); // Calls props.onClick(eventData)
 * ```
 */
export function createEmit(reactiveProps: { value?: Record<string, any> } | Record<string, any>): (event: string, ...args: any[]) => void {
    return (event: string, ...args: any[]) => {
        const eventName = `on${event[0].toUpperCase() + event.slice(1)}`;
        // Handle both signal-wrapped props and plain props
        const props = 'value' in reactiveProps ? reactiveProps.value : reactiveProps;
        const handler = props?.[eventName];
        if (handler && typeof handler === 'function') {
            handler(...args);
        }
    };
}
