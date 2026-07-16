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

// SVG elements, for resolving the namespace of elements whose surrounding
// context is unknown (hydrated subtrees patched from the top). Core is
// namespace-agnostic: it threads an opaque boolean flag that the namespace
// ops below give meaning to ("in the SVG namespace").
const svgTags = new Set([
    'svg', 'animate', 'animateMotion', 'animateTransform', 'circle', 'clipPath',
    'defs', 'desc', 'ellipse', 'feBlend', 'feColorMatrix', 'feComponentTransfer',
    'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
    'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG',
    'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
    'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence', 'filter', 'foreignObject', 'g', 'image', 'line', 'linearGradient',
    'marker', 'mask', 'metadata', 'mpath', 'path', 'pattern', 'polygon', 'polyline',
    'radialGradient', 'rect', 'set', 'stop', 'switch', 'symbol', 'text', 'textPath',
    'title', 'tspan', 'use', 'view'
]);

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
    onElementUnmounted,
    // Namespace resolution. With a known context (parentNS is a boolean):
    // entering SVG happens exactly at <svg>, and leaving at <foreignObject>,
    // whose subtree — and, per the historical behavior asserted in the
    // svg-rendering tests, the element itself — is HTML. With no context
    // (parentNS === undefined, a hydrated subtree patched from the top):
    // classification falls back to the SVG tag list, which deliberately
    // includes foreignObject like any other SVG tag name.
    getElementNamespace: (tag, parentNS) =>
        parentNS === undefined
            ? svgTags.has(tag)
            : tag === 'svg' || (parentNS && tag !== 'foreignObject'),
    getChildNamespace: (tag, isSVG) => isSVG && tag !== 'foreignObject',
    getContainerNamespace: (tag, isSVG) => isSVG && tag !== 'svg'
};
