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
import { normalizeElement, setCurrentAppContext, getCurrentAppContext, getClientPlugins } from './hydrate-context';
import { hydrateComponent } from './hydrate-component';

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

    // Walk existing DOM, attach handlers, and mount components
    hydrateNode(vnode, container.firstChild, container);

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
        // When a text VNode hits a <!--t--> separator, the SSR may have omitted the
        // preceding empty text (e.g. "" + " · Logout" → <!--t--> · Logout).
        // Replace the comment with an empty text node so this VNode can attach to it,
        // preserving the boundary for the next text VNode.
        if (isTextVNode && (dom as globalThis.Comment).data === 't') {
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
        // Let plugins intercept component hydration (e.g., islands scheduling)
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
        if (!dom || dom.nodeType !== Node.ELEMENT_NODE) {
            if (process.env.NODE_ENV !== 'production') {
                const cls = vnode.props?.class || '';
                console.warn('[Hydrate] Expected element but got:', dom, '| tag:', vnode.type, '| class:', cls, '| parent:', parent?.nodeName);
            }
            return dom;
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
                    patchProp(el, key, null, vnode.props[key]);
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
