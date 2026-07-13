/**
 * DOM node operations and SVG support.
 *
 * Provides the complete RendererOptions implementation for the DOM platform,
 * including element creation, insertion, removal, text manipulation,
 * focus preservation, and SVG namespace handling.
 */

import type { RendererOptions } from '@sigx/runtime-core/internals';
import { patchProp } from './patchProp.js';
import { patchDirective, onElementMounted, onElementUnmounted } from './directives.js';

// SVG namespace for createElementNS
const svgNS = 'http://www.w3.org/2000/svg';

export const nodeOps: RendererOptions<Node, Element> = {
    insert: (child, parent, anchor) => {
        if (anchor && anchor.parentNode !== parent) anchor = null;
        parent.insertBefore(child, anchor || null);
    },
    remove: (child) => {
        const parent = child.parentNode;
        if (parent) {
            parent.removeChild(child);
        }
    },
    createElement: (tag, isSVG, isCustomizedBuiltIn) => {
        if (isSVG) {
            return document.createElementNS(svgNS, tag);
        }
        const is = isCustomizedBuiltIn ? { is: isCustomizedBuiltIn } : undefined;
        return document.createElement(tag, is);
    },
    createText: (text) => document.createTextNode(text),
    createComment: (text) => document.createComment(text),
    setText: (node, text) => {
        node.nodeValue = text;
    },
    setElementText: (el, text) => {
        el.textContent = text;
    },
    parentNode: (node) => node.parentNode as Element,
    nextSibling: (node) => node.nextSibling,
    querySelector: (selector) => document.querySelector(selector),
    setScopeId: (el, id) => el.setAttribute(id, ''),
    cloneNode: (node) => node.cloneNode(true),
    getActiveElement: () => document.activeElement as Element | null,
    restoreFocus: (el) => {
        if (el instanceof HTMLElement || el instanceof SVGElement) {
            // Use preventScroll to avoid layout thrashing.
            // Suppress focus/blur events to prevent re-triggering reactive updates.
            const suppressEvent = (e: Event) => { e.stopImmediatePropagation(); };
            el.addEventListener('focus', suppressEvent, { capture: true, once: true });
            el.addEventListener('focusin', suppressEvent, { capture: true, once: true });
            // Also suppress blur on the element that will lose focus
            const current = document.activeElement;
            if (current instanceof HTMLElement) {
                current.addEventListener('blur', suppressEvent, { capture: true, once: true });
                current.addEventListener('focusout', suppressEvent, { capture: true, once: true });
            }
            el.focus({ preventScroll: true });
        }
    },
    patchProp,
    patchDirective,
    onElementMounted,
    onElementUnmounted
};
