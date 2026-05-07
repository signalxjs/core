/**
 * Portal component for rendering children to a different DOM location.
 * 
 * Uses the `moveBefore` API (Chrome 133+) when available for state-preserving
 * DOM moves. Falls back to `insertBefore` for older browsers.
 * 
 * @example
 * ```tsx
 * import { Portal } from '@sigx/runtime-dom';
 * 
 * // Render to document.body (default)
 * <Portal>
 *   <div class="modal">Modal content</div>
 * </Portal>
 * 
 * // Render to a specific container
 * <Portal to={document.getElementById('modal-root')}>
 *   <div class="modal">Modal content</div>
 * </Portal>
 * 
 * // Render to a container by selector
 * <Portal to="#modal-root">
 *   <div class="modal">Modal content</div>
 * </Portal>
 * ```
 */

import { component, Fragment, VNode, jsx, type Define } from '@sigx/runtime-core';
import { normalizeSubTree } from '@sigx/runtime-core/internals';
import { effect } from '@sigx/reactivity';
import { mount, unmount, patch } from './render.js';

/**
 * Check if the browser supports the moveBefore API.
 * moveBefore allows moving DOM nodes without losing state (iframes, videos, focus, etc.)
 */
export function supportsMoveBefore(): boolean {
    return typeof Node !== 'undefined' && 'moveBefore' in Node.prototype;
}

/**
 * Move or insert a node into a parent, using moveBefore when available
 * for state-preserving moves.
 * 
 * @param parent - The target parent element
 * @param node - The node to move/insert
 * @param anchor - Optional reference node to insert before
 */
export function moveNode(
    parent: Element,
    node: Node,
    anchor: Node | null = null
): void {
    if (supportsMoveBefore()) {
        // Use moveBefore for state-preserving move (Chrome 133+)
        (parent as any).moveBefore(node, anchor);
    } else {
        // Fallback to insertBefore (causes state reset for iframes, etc.)
        parent.insertBefore(node, anchor);
    }
}

/**
 * Resolve a portal target from a string selector or Element.
 * Returns document.body as fallback.
 */
function resolveTarget(target: string | Element | undefined): Element {
    if (target === undefined) {
        return document.body;
    }
    
    if (typeof target === 'string') {
        const resolved = document.querySelector(target);
        if (!resolved) {
            console.warn(`Portal: Target "${target}" not found, falling back to document.body`);
            return document.body;
        }
        return resolved;
    }
    
    return target;
}

type PortalProps = Define.Prop<'to', string | Element> & Define.Prop<'disabled', boolean>;

/**
 * Portal component - renders children to a different DOM location.
 * 
 * Props:
 * - `to` - Target container (Element or CSS selector string). Defaults to document.body.
 * - `disabled` - When true, renders children in place instead of portaling
 * - `children` - Content to render in the portal
 * 
 * Features:
 * - Uses `moveBefore` API (Chrome 133+) for state-preserving DOM moves
 * - Preserves iframe content, video playback, focus, and CSS animations
 * - Falls back to `insertBefore` for older browsers
 */
export const Portal = component<PortalProps>(({ props, slots, onMounted, onUnmounted }) => {
    // Container element for portal content
    let portalContainer: HTMLDivElement | null = null;
    let mountedVNode: VNode | null = null;
    let cleanupEffect: (() => void) | null = null;

    onMounted(() => {
        if (props.disabled) {
            return;
        }

        // Resolve target container
        const targetContainer = resolveTarget(props.to);

        // Create a container div for the portal content
        portalContainer = document.createElement('div');
        portalContainer.setAttribute('data-sigx-portal', '');

        // Use moveBefore when available for state-preserving move
        moveNode(targetContainer, portalContainer);

        // Set up reactive effect to render children into portal container
        const stopEffect = effect(() => {
            const children = slots.default();
            
            if (!portalContainer) return;
            
            // Normalize children to a proper VNode using the shared utility
            const vnode = normalizeSubTree(children);

            if (mountedVNode) {
                // Patch existing content
                patch(mountedVNode, vnode, portalContainer);
            } else {
                // Initial mount
                mount(vnode, portalContainer);
            }
            
            mountedVNode = vnode;
        });

        cleanupEffect = stopEffect;
    });

    onUnmounted(() => {
        // Stop the reactive effect
        if (cleanupEffect) {
            cleanupEffect();
            cleanupEffect = null;
        }

        // Unmount the portal content
        if (mountedVNode && portalContainer) {
            unmount(mountedVNode, portalContainer);
            mountedVNode = null;
        }

        // Remove the portal container from the DOM
        if (portalContainer && portalContainer.parentNode) {
            portalContainer.parentNode.removeChild(portalContainer);
        }
        portalContainer = null;
    });

    return () => {
        // When disabled, render children in place using jsx function
        if (props.disabled) {
            const children = slots.default();
            return jsx(Fragment, { children });
        }

        // When portal is active, render nothing in place
        // Children are rendered into the portal container via the effect
        return null;
    };
}, { name: 'Portal' });
