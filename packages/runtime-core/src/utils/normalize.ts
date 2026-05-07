/**
 * VNode normalization utilities.
 * Converts render results into proper VNode structures.
 */

import { isComputed } from '@sigx/reactivity';
import { VNode, Fragment, Text, JSXElement } from '../jsx-runtime.js';

/**
 * Normalize render result to a VNode (wrapping arrays in Fragment).
 * Handles null, undefined, false, true by returning an empty Text node.
 * 
 * This is used to normalize the return value of component render functions
 * into a consistent VNode structure for the renderer to process.
 * 
 * @example
 * ```ts
 * // Conditional rendering returns null/false
 * normalizeSubTree(null)     // → empty Text node
 * normalizeSubTree(false)    // → empty Text node
 * 
 * // Arrays become Fragments
 * normalizeSubTree([<A/>, <B/>])  // → Fragment with children
 * 
 * // Primitives become Text nodes
 * normalizeSubTree("hello")  // → Text node
 * normalizeSubTree(42)       // → Text node
 * 
 * // Computed signals are auto-unwrapped
 * normalizeSubTree(computed(() => "hi"))  // → Text node with "hi"
 * 
 * // VNodes pass through
 * normalizeSubTree(<div/>)   // → same VNode
 * ```
 */
export function normalizeSubTree(result: JSXElement | JSXElement[] | null | undefined | boolean | (() => any)): VNode {
    // Handle falsy values from conditional rendering
    if (result == null || result === false || result === true) {
        return {
            type: Text,
            props: {},
            key: null,
            children: [],
            dom: null,
            text: ''
        };
    }

    // Auto-unwrap computed signals
    if (isComputed(result)) {
        return normalizeSubTree(result.value as JSXElement | JSXElement[] | (() => any) | undefined);
    }

    if (Array.isArray(result)) {
        return {
            type: Fragment,
            props: {},
            key: null,
            children: result as VNode[],
            dom: null
        };
    }

    if (typeof result === 'string' || typeof result === 'number') {
        return {
            type: Text,
            props: {},
            key: null,
            children: [],
            dom: null,
            text: result
        };
    }

    return result as VNode;
}
