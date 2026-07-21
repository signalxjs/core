/**
 * Core hydration logic — strategy-agnostic
 *
 * Walks existing server-rendered DOM and attaches event handlers,
 * creates reactive effects, and delegates components to the component hydrator.
 *
 * Plugins registered via `registerClientPlugin()` can intercept component
 * hydration (e.g., for deferred/island-based hydration strategies).
 */

import {
    VNode,
    Fragment,
    Text,
    Comment,
    isComponent,
} from 'sigx';
import { patchProp, patchDirective, onElementMounted } from 'sigx/internals';
import type { AppContext } from 'sigx';
import { normalizeElement, setCurrentAppContext, getCurrentAppContext, getClientPlugins, isFormattingWhitespace } from './hydrate-context';
import { hydrateComponent } from './hydrate-component';
import { getHydrateDefaults } from './hydrate-defaults';
import {
    getBoundaryTable,
    scheduleTableBoundaries,
    findComponentBoundaries,
    parseMarkerId
} from './scheduler';
import { scheduleWalkedBoundary, hydrateLeftoverBoundaries } from './hydration-core';
import type { SSRBoundaryRecord } from '../boundary';

/**
 * Walk-scoped boundary table — set by hydrate() when the page carries a
 * non-empty __SIGX_BOUNDARIES__ table, consulted in hydrateNode's component
 * branch. Null on the boundary-free fast path: the walk pays nothing.
 */
let _walkTable: Record<string, SSRBoundaryRecord> | null = null;

/**
 * Hydrate a server-rendered app.
 *
 * This walks the existing DOM to attach event handlers, runs component
 * setup functions to establish reactivity, then uses runtime-dom for updates.
 *
 * Registered client plugins are called at appropriate points:
 * - `beforeHydrate`: before the DOM walk (return false to skip it entirely)
 * - `hydrateComponent`: for each component (return { next } to handle it)
 * - `afterHydrate`: after the DOM walk completes
 *
 * @param element - The root element/VNode to hydrate
 * @param container - The DOM container with SSR content
 * @param appContext - The app context for DI (provides, etc.)
 */
export function hydrate(element: any, container: Element, appContext?: AppContext): void {
    const vnode = normalizeElement(element);
    if (!vnode) return;

    // Store app context for component hydration (DI needs this)
    setCurrentAppContext(appContext ?? null);

    const plugins = getClientPlugins();

    // Let plugins intercept before the DOM walk
    for (const plugin of plugins) {
        const result = plugin.client?.beforeHydrate?.(container);
        if (result === false) {
            // Plugin opted out of the default DOM walk (e.g., resumable SSR)
            (container as any)._vnode = vnode;
            return;
        }
    }

    const table = getBoundaryTable();
    let hasBoundaries = false;
    for (const _key in table) { hasBoundaries = true; break; }

    // boundaries: 'explicit' (provided per app, e.g. by islandsPlugin's
    // install) — no root walk; ONLY boundary-table entries hydrate.
    if (getHydrateDefaults(appContext).boundaries === 'explicit') {
        scheduleTableBoundaries();
        // Streamed boundaries whose $SIGX_REPLACE ran before the listener
        // was ready still need hydrating — same scan as the walk path.
        if (hasBoundaries) {
            hydrateLeftoverBoundaries(container);
        }
        for (const plugin of plugins) {
            plugin.client?.afterHydrate?.(container);
        }
        (container as any)._vnode = vnode;
        return;
    }

    // Walk existing DOM, attach handlers, and mount components. With a
    // boundary table present, the walk intercepts recorded boundaries and
    // schedules them per strategy; without one this is exactly the plain
    // single walk (zero added work).
    _walkTable = hasBoundaries ? table : null;
    try {
        hydrateNode(vnode, container.firstChild, container);
    } finally {
        _walkTable = null;
    }

    // Streamed boundaries whose $SIGX_REPLACE ran before the listener was
    // ready still need hydrating.
    if (hasBoundaries) {
        hydrateLeftoverBoundaries(container);
    }

    // Post-hydration hooks
    for (const plugin of plugins) {
        plugin.client?.afterHydrate?.(container);
    }

    // Store vnode on container for potential future use
    (container as any)._vnode = vnode;
}

/**
 * Hydrate a VNode against existing DOM
 * This only attaches event handlers and refs - no DOM creation
 */
export function hydrateNode(vnode: VNode, dom: Node | null, parent: Node): Node | null {
    if (!vnode) return dom;

    // Skip comment nodes (<!--t--> text separators and <!--$c:N--> component markers).
    // Component markers are only meaningful when the VNode itself is a component —
    // for element/text/fragment VNodes, all comments are just SSR artifacts to skip past.
    const isComponentVNode = isComponent(vnode.type);
    const isTextVNode = vnode.type === Text;
    const isCommentVNode = vnode.type === Comment;
    while (dom && dom.nodeType === Node.COMMENT_NODE) {
        // Comment VNodes match empty comment placeholders emitted by SSR
        if (isCommentVNode && (dom as globalThis.Comment).data === '') {
            break;
        }
        if (isComponentVNode) {
            const commentText = (dom as globalThis.Comment).data;
            // Stop at component markers — the component hydrator needs them for boundaries
            if (commentText.startsWith('$c:')) {
                break;
            }
        }
        // <!--t--> is a boundary between adjacent text children. SSR emits it
        // so the browser parser doesn't merge two text VNodes into one DOM
        // text node.
        //  - If the VNode's text is non-empty and a real text node follows the
        //    marker, that real text node is this VNode's target — advance past
        //    the marker.
        //  - Otherwise the marker stands in for an omitted empty text node
        //    (e.g. "" + " · Logout" → <!--t--> · Logout). Replace it with an
        //    empty text node and bind this VNode to it.
        if (isTextVNode && (dom as globalThis.Comment).data === 't') {
            const next = dom.nextSibling;
            const vnodeIsEmpty = vnode.text == null || vnode.text === '';
            if (!vnodeIsEmpty && next && next.nodeType === Node.TEXT_NODE) {
                dom = next;
                break;
            }
            const emptyText = document.createTextNode('');
            parent.replaceChild(emptyText, dom);
            dom = emptyText;
            break;
        }
        dom = dom.nextSibling;
    }

    if (vnode.type === Comment) {
        // SSR emits <!---> for falsy children — attach to the comment node
        if (dom && dom.nodeType === Node.COMMENT_NODE) {
            vnode.dom = dom;
            return dom.nextSibling;
        }
        // Fallback: create a comment node if SSR didn't emit one (mismatch recovery)
        const comment = document.createComment('');
        if (dom) {
            parent.insertBefore(comment, dom);
        } else {
            parent.appendChild(comment);
        }
        vnode.dom = comment;
        return dom;
    }

    if (vnode.type === Text) {
        if (dom && dom.nodeType === Node.TEXT_NODE) {
            vnode.dom = dom;
            return dom.nextSibling;
        }
        // Hydration mismatch: expected a text node but got something else.
        // Create a fresh text node and insert it so the VNode has a valid DOM ref.
        const textNode = document.createTextNode(String(vnode.text ?? ''));
        if (dom) {
            parent.insertBefore(textNode, dom);
        } else {
            parent.appendChild(textNode);
        }
        vnode.dom = textNode;
        return dom;
    }

    if (vnode.type === Fragment) {
        let current = dom;
        for (const child of vnode.children) {
            current = hydrateNode(child, current, parent);
        }
        return current;
    }

    if (isComponent(vnode.type)) {
        // Boundary-table interception: a component recorded in the table
        // schedules per its strategy instead of hydrating inline
        // (hydrate:'load' records schedule immediately — same walk order,
        // plus the state-snapshot staging). Paid only when a table exists.
        if (_walkTable) {
            const { trailingMarker } = findComponentBoundaries(dom);
            const id = trailingMarker ? parseMarkerId(trailingMarker) : null;
            const record = id !== null ? _walkTable[String(id)] : undefined;
            if (record) {
                return scheduleWalkedBoundary(vnode, dom, parent, record);
            }
        }

        // Let plugins intercept component hydration
        const plugins = getClientPlugins();
        for (const plugin of plugins) {
            const result = plugin.client?.hydrateComponent?.(vnode, dom, parent);
            if (result !== undefined) {
                // Plugin handled this component — return the next DOM node
                return result;
            }
        }

        // No plugin handled it — hydrate immediately
        return hydrateComponent(vnode, dom, parent);
    }

    if (typeof vnode.type === 'string') {
        const wantTag = vnode.type.toLowerCase();
        const matchesTag = (node: Node | null): node is Element =>
            node != null
            && node.nodeType === Node.ELEMENT_NODE
            && (node as Element).tagName.toLowerCase() === wantTag;

        if (!matchesTag(dom)) {
            // Scan forward through remaining siblings for a matching element.
            // This recovers from minor cursor drift without falling back to
            // mount-fresh, which would otherwise duplicate content.
            let scan: Node | null = dom;
            // Track whether anything we skipped was REAL content. Whitespace
            // text and comment artifacts are markup formatting, not drift —
            // warning on those would fire for every element on an indented
            // page and drown the signal this warning exists to carry.
            let skippedRealContent = false;
            while (scan && !matchesTag(scan)) {
                if (scan.nodeType !== Node.COMMENT_NODE && !isFormattingWhitespace(scan)) {
                    skippedRealContent = true;
                }
                scan = scan.nextSibling;
            }
            if (scan) {
                if (__DEV__ && scan !== dom && skippedRealContent) {
                    // Skipped over orphan siblings on the way to a matching
                    // element. Surface SSR drift instead of silently papering
                    // over it — the skipped nodes stay in the DOM as visible
                    // content no VNode owns.
                    console.warn('[Hydrate] Skipped non-matching sibling(s) to reach <' + vnode.type + '>; SSR output may not match the client VNode tree.', '| parent:', parent?.nodeName);
                }
                dom = scan;
            } else {
                // Last-resort mismatch recovery: SSR didn't emit the expected
                // element. Create a fresh one so vnode.dom is always bound,
                // matching the recovery pattern used in the Text/Comment
                // branches above. Without this, a later reactive patch with
                // an undefined vnode.dom would mount fresh at the end of the
                // parent and produce a duplicate.
                if (__DEV__) {
                    const cls = vnode.props?.class || '';
                    console.warn('[Hydrate] Expected element but got:', dom, '| tag:', vnode.type, '| class:', cls, '| parent:', parent?.nodeName);
                }
                const fresh = document.createElement(vnode.type);
                if (dom) {
                    parent.insertBefore(fresh, dom);
                } else {
                    parent.appendChild(fresh);
                }
                vnode.dom = fresh;
                let hasDirectives = false;
                if (vnode.props) {
                    for (const key in vnode.props) {
                        if (key === 'children' || key === 'key') continue;
                        if (key.startsWith('client:')) continue;
                        if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                            patchDirective(fresh, key.slice(4), null, vnode.props[key], getCurrentAppContext());
                            hasDirectives = true;
                        } else if (key !== 'ref') {
                            patchProp(fresh, key, null, vnode.props[key], undefined, getCurrentAppContext());
                        }
                    }
                    if (hasDirectives) {
                        onElementMounted(fresh);
                    }
                    if (vnode.props.ref) {
                        if (typeof vnode.props.ref === 'function') {
                            vnode.props.ref(fresh);
                        } else if (typeof vnode.props.ref === 'object') {
                            vnode.props.ref.current = fresh;
                        }
                    }
                }
                // Mount children fresh into the empty element.
                let childDom: Node | null = null;
                for (const child of vnode.children) {
                    childDom = hydrateNode(child, childDom, fresh);
                }
                if (vnode.type === 'select' && vnode.props) {
                    fixSelectValue(fresh as HTMLElement, vnode.props);
                }
                // Advance past both the inserted `fresh` and the original
                // mismatched `dom` (now orphaned). Returning `dom` would let
                // the next sibling VNode bind to the orphan, cascading the
                // mismatch.
                return dom ? dom.nextSibling : null;
            }
        }

        const el = dom as Element;
        vnode.dom = el;

        // Attach event handlers and props using patchProp from runtime-dom
        if (vnode.props) {
            let hasDirectives = false;
            for (const key in vnode.props) {
                if (key === 'children' || key === 'key') continue;
                if (key.startsWith('client:')) continue;

                if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                    // Route use:* directive props through patchDirective
                    patchDirective(el, key.slice(4), null, vnode.props[key], getCurrentAppContext());
                    hasDirectives = true;
                } else {
                    // Use patchProp for consistent prop handling (events, refs, etc.)
                    patchProp(el, key, null, vnode.props[key], undefined, getCurrentAppContext());
                }
            }

            // Fire mounted hooks for directives (element is already in DOM during hydration)
            if (hasDirectives) {
                onElementMounted(el);
            }

            // Handle ref - patchProp skips refs, so we handle them here
            if (vnode.props.ref) {
                if (typeof vnode.props.ref === 'function') {
                    vnode.props.ref(el);
                } else if (typeof vnode.props.ref === 'object') {
                    vnode.props.ref.current = el;
                }
            }
        }

        // Hydrate children
        let childDom: Node | null = el.firstChild;
        for (const child of vnode.children) {
            childDom = hydrateNode(child, childDom, el);
        }

        // Fix select value after children are hydrated
        if (vnode.type === 'select' && vnode.props) {
            fixSelectValue(el as HTMLElement, vnode.props);
        }

        return el.nextSibling;
    }

    return dom;
}

/**
 * Fix select element value after hydrating children.
 * This is needed because <select>.value only works after <option> children exist in DOM.
 */
function fixSelectValue(dom: HTMLElement, props: any) {
    if (dom.tagName === 'SELECT' && 'value' in props) {
        const val = props.value;
        if ((dom as HTMLSelectElement).multiple) {
            const options = (dom as HTMLSelectElement).options;
            const valArray = Array.isArray(val) ? val : [val];
            for (let i = 0; i < options.length; i++) {
                options[i].selected = valArray.includes(options[i].value);
            }
        } else {
            (dom as HTMLSelectElement).value = String(val);
        }
    }
}
