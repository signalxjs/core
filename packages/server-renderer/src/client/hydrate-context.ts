/**
 * Hydration context and state management
 *
 * Manages app context tracking, client plugin registration, and the SSR
 * context extension for components (environment flags).
 *
 * Strategy-specific concerns (island data, async hydration) are handled
 * by plugins registered via `registerClientPlugin()`.
 */

import {
    VNode,
    Text,
} from 'sigx';
import { registerContextExtension } from 'sigx/internals';
import type { AppContext } from 'sigx';
import type { SSRPlugin } from '../plugin';

// ============= Internal Types =============

export interface InternalVNode extends VNode {
    _subTree?: VNode;
    _subTreeRef?: { current: VNode | null };
    _effect?: any;
    _componentProps?: any;
    _slots?: any;
}

// ============= Module State =============

// Track current app context during hydration for DI
// Used for deferred hydration callbacks
let _currentAppContext: AppContext | null = null;

// Registered client-side SSR plugins
let _clientPlugins: SSRPlugin[] = [];

// ============= Client Plugin Registry =============

/**
 * Register a client-side SSR plugin.
 * Plugins are called during hydration to intercept component processing,
 * skip default hydration walk, or run post-hydration logic.
 */
export function registerClientPlugin(plugin: SSRPlugin): void {
    _clientPlugins.push(plugin);
}

/**
 * Get all registered client-side plugins.
 */
export function getClientPlugins(): SSRPlugin[] {
    return _clientPlugins;
}

/**
 * Clear all registered client plugins (useful for testing).
 */
export function clearClientPlugins(): void {
    _clientPlugins = [];
}

// ============= State Accessors =============

/** Get the current app context for deferred hydration */
export function getCurrentAppContext(): AppContext | null {
    return _currentAppContext;
}

/** Set the current app context during hydration */
export function setCurrentAppContext(ctx: AppContext | null): void {
    _currentAppContext = ctx;
}

// ============= Element Normalization =============

/**
 * Normalize any element to VNode
 */
export function normalizeElement(element: any): VNode | null {
    if (element == null || element === true || element === false) {
        return null;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        return {
            type: Text,
            props: {},
            key: null,
            children: [],
            dom: null,
            text: element
        };
    }

    return element as VNode;
}

// ============= Context Extension Registration =============

/**
 * Register the SSR context extension for all components.
 * This provides the `ssr` environment-flags object for client-side rendering.
 * Data loading and server-state restoration live in useAsync/useStream.
 */
registerContextExtension((ctx: any) => {
    // Client-side environment flags. Data loading lives in useAsync/useStream
    // (runtime-core) — restored values come from window.__SIGX_ASYNC__ there.
    ctx.ssr = {
        isServer: false,
        isHydrating: false
    };
});
