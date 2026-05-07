/**
 * Hydration context and state management
 *
 * Manages server state restoration, app context tracking,
 * client plugin registration, and the SSR context extension for components.
 *
 * Strategy-specific concerns (island data, async hydration) are handled
 * by plugins registered via `registerClientPlugin()`.
 */

import {
    VNode,
    signal,
    Text,
} from 'sigx';
import { registerContextExtension } from 'sigx/internals';
import type { AppContext } from 'sigx';
import type { SSRPlugin } from '../plugin';
import type { SSRSignalFn } from '../server/types';
import { generateSignalKey } from '../server/types';

// ============= Internal Types =============

export interface InternalVNode extends VNode {
    _subTree?: VNode;
    _subTreeRef?: { current: VNode | null };
    _effect?: any;
    _componentProps?: any;
    _slots?: any;
}

// Re-export SSRSignalFn from shared types so existing consumers work
export type { SSRSignalFn };

// ============= Module State =============

// Track server state for async components being mounted after streaming
let _pendingServerState: Record<string, any> | null = null;

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

/**
 * Set server state that should be used for the next component mount.
 * Used internally when mounting async components after streaming.
 */
export function setPendingServerState(state: Record<string, any> | null): void {
    _pendingServerState = state;
}

/** Get the current app context for deferred hydration */
export function getCurrentAppContext(): AppContext | null {
    return _currentAppContext;
}

/** Set the current app context during hydration */
export function setCurrentAppContext(ctx: AppContext | null): void {
    _currentAppContext = ctx;
}

// ============= Signal Restoration =============

/**
 * Creates a signal function that restores state from server-captured values.
 * Used during hydration of async components to avoid re-fetching data.
 * Supports both primitive and object signals.
 */
export function createRestoringSignal(serverState: Record<string, any>): SSRSignalFn {
    let signalIndex = 0;
    let hasWarnedPositional = false;

    return function restoringSignal(initial: any, name?: string): any {
        // Generate a stable key for this signal (must match server-side)
        const key = generateSignalKey(name, signalIndex++);

        // Dev warning: positional keys are fragile
        if (process.env.NODE_ENV !== 'production' && !name && !hasWarnedPositional) {
            hasWarnedPositional = true;
            console.warn(
                `[SSR Hydration] Signal restored without a name — using positional key "${key}". ` +
                `If signal declaration order differs between server and client builds, ` +
                `state will be silently mismatched. Use named signals: signal(value, "name")`
            );
        }

        // Check if we have server state for this signal
        if (key in serverState) {
            return signal(serverState[key]);
        }

        // No server state, use initial value
        return signal(initial as any);
    } as SSRSignalFn;
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
 * This provides the `ssr` object with a no-op `load()` for client-side rendering.
 * Also handles server state restoration for async streamed components.
 */
registerContextExtension((ctx: any) => {
    // Check if we have pending server state (from async streaming)
    const serverState = _pendingServerState;
    if (serverState) {
        ctx._serverState = serverState;
        _pendingServerState = null; // Clear after use

        // Override signal function to use restoring signal
        ctx.signal = createRestoringSignal(serverState);

        // ssr.load() should be a no-op since we have restored state
        ctx.ssr = {
            load: (_fn: () => Promise<void>) => {
                // Skip - using restored server state
            },
            isServer: false,
            isHydrating: true
        };
    } else if (ctx._serverState) {
        // Already has server state (from hydration)
        ctx.ssr = {
            load: (_fn: () => Promise<void>) => {
                // Skip - using restored server state
            },
            isServer: false,
            isHydrating: true
        };
    } else {
        // Default client-side ssr helper - runs async functions for client-side navigation
        ctx.ssr = {
            load: (fn: () => Promise<void>) => {
                // On client-side navigation (not hydration), execute the async function
                fn().catch(err => console.error('[SSR] load error:', err));
            },
            isServer: false,
            isHydrating: false
        };
    }
});
