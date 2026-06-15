/**
 * Client hydration directives — types + runtime helpers.
 *
 * These directives control selective hydration for SSR island components. The
 * directive runtime is owned here, by the islands package: core's
 * `@sigx/server-renderer` is strategy-agnostic and has no knowledge of the
 * `client:*` vocabulary. (Previously these helpers were imported from
 * `sigx/internals`; inlining them keeps the pack self-contained — see #25.)
 */

import type { HydrationStrategy } from './types';

export interface ClientDirectives {
    'client:load'?: boolean;
    'client:idle'?: boolean;
    'client:visible'?: boolean;
    'client:media'?: string;
    'client:only'?: boolean;
}

// Augment types in runtime-core for island-specific client:* directives.
// SSRHelper and ComponentSetupContext SSR fields are owned by @sigx/server-renderer.
declare module '@sigx/runtime-core' {
    interface ComponentAttributeExtensions extends ClientDirectives { }
}

/** Prefix marking a prop as a client hydration directive. */
export const CLIENT_DIRECTIVE_PREFIX = 'client:';

/** Resolved hydration directive for a component (strategy + optional media). */
export interface HydrationDirective {
    strategy: HydrationStrategy;
    media?: string;
}

/**
 * Strip client:* directives from props, leaving the real component props.
 *
 * @example
 * filterClientDirectives({ 'client:visible': true, name: 'x' }); // { name: 'x' }
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
 * Resolve the hydration directive (strategy + optional media query) from props,
 * or null when the component carries no client:* directive.
 *
 * @example
 * getHydrationDirective({ 'client:visible': true });              // { strategy: 'visible' }
 * getHydrationDirective({ 'client:media': '(min-width: 768px)' }); // { strategy: 'media', media: '(min-width: 768px)' }
 * getHydrationDirective({ name: 'x' });                           // null
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
 * Serialize props for client hydration: drops directives, framework-internal
 * props, functions, symbols, undefined, and event handlers. Returns undefined
 * when nothing serializable remains.
 *
 * @example
 * serializeProps({ name: 'x', onClick: () => {} }); // { name: 'x' }
 * serializeProps({ onClick: () => {} });            // undefined
 */
export function serializeProps(props: Record<string, any>): Record<string, any> | undefined {
    const filtered = filterClientDirectives(props);

    const result: Record<string, any> = {};
    let hasProps = false;

    for (const key in filtered) {
        const value = filtered[key];

        // Skip framework-internal props.
        if (key === 'children' || key === 'key' || key === 'ref' || key === 'slots') continue;
        // Skip functions (event handlers, etc.) and symbols.
        if (typeof value === 'function') continue;
        if (typeof value === 'symbol') continue;
        // Skip undefined values.
        if (value === undefined) continue;
        // Skip event handlers (on* props).
        if (key.startsWith('on') && key.length > 2 && key[2] === key[2].toUpperCase()) continue;

        // Keep only JSON-serializable values.
        try {
            JSON.stringify(value);
            result[key] = value;
            hasProps = true;
        } catch {
            // Non-serializable, skip.
        }
    }

    return hasProps ? result : undefined;
}
