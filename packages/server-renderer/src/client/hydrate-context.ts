/**
 * Hydration context helpers — the HEAVY half of what used to be one module.
 *
 * Element normalization needs `Text` from the runtime and the module-scope
 * `registerContextExtension` call needs `sigx/internals`, so this module
 * lives on the hydration-core side of the scheduler/core split and loads
 * with the executor. The client plugin registry and app-context tracking —
 * which packs need EAGERLY, before any runtime code loads — moved to
 * `./plugin-registry` (re-exported below so in-package imports keep
 * working).
 */

import {
    VNode,
    Text,
} from 'sigx';
import { registerContextExtension } from 'sigx/internals';

// Re-export the eager plugin registry / app-context surface: this module is
// where these names historically lived, and the hydration-side modules
// import them from here.
export {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    resolveClientPlugins,
    hasPendingClientPlugins,
    getCurrentAppContext,
    setCurrentAppContext
} from './plugin-registry';
export type { ClientPluginSource, LazyClientPlugin } from './plugin-registry';

// ============= Internal Types =============

export interface InternalVNode extends VNode {
    _subTree?: VNode;
    _subTreeRef?: { current: VNode | null };
    _effect?: any;
    _componentProps?: any;
    _slots?: any;
}

// ============= SSR Formatting Artifacts =============

/**
 * Is this text node pure markup formatting (indentation between tags) rather
 * than content SSR rendered for a component?
 *
 * Deliberately NOT `/\S/`: JavaScript's `\s` class matches NBSP (` `) and
 * the other Unicode space separators, which are VISIBLE characters. An SSR
 * `&nbsp;` is real content — skipping it would let the hydrator abandon
 * visible text as an orphan no VNode owns. Only HTML's ASCII whitespace
 * (space, tab, LF, FF, CR) can appear as pretty-printing between tags, so that
 * is exactly the set treated as skippable.
 */
export function isFormattingWhitespace(node: Node): boolean {
    return node.nodeType === 3 /* TEXT_NODE */
        && !/[^ \t\n\f\r]/.test((node as globalThis.Text).data);
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
