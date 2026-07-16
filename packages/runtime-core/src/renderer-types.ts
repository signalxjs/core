/**
 * Type definitions for the renderer system.
 *
 * Exported interfaces used by platform renderers (e.g., runtime-dom),
 * SSR hydration, and framework extensions.
 */

import type { VNode, JSXElement } from './jsx-runtime.js';
import type { EffectRunner } from '@sigx/reactivity';
import type { SetupFn } from './component.js';
import type { InternalSlotsObject } from './utils/slots.js';
import type { AppContext } from './app.js';

/**
 * Internal VNode with renderer-specific properties.
 * These properties are used by the renderer to track component state
 * but are not part of the public VNode API.
 */
export interface InternalVNode extends VNode {
    /** The reactive effect that re-renders the component */
    _effect?: EffectRunner;
    /**
     * Cached host namespace flag, resolved contextually via the host's
     * namespace ops at mount and carried forward on every same-type patch.
     * Opaque to core — the platform defines its meaning (e.g. "created in
     * the SVG namespace" in runtime-dom). Hydrated vnodes don't have it
     * until their first patch.
     */
    _ns?: boolean;
    /** The rendered sub-tree VNode of a component */
    _subTree?: VNode | null;
    /**
     * Shared mutable reference to the current sub-tree.
     * Used to keep _subTree in sync across VNode replacements during same-type patches.
     * The effect closure writes to this ref, and all aliased VNodes share it.
     */
    _subTreeRef?: { current: VNode | null };
    /** The slots object for component children */
    _slots?: InternalSlotsObject;
    /** Reactive props signal for the component */
    _componentProps?: Record<string, any>;
    /**
     * The value the component exposed via `ctx.expose(...)` (null if not called).
     * Captured at mount time so that ref updates during same-type patches can
     * invoke a newly-supplied ref with the same value the original ref received.
     */
    _exposed?: any;
}

export interface RendererOptions<HostNode = any, HostElement = any> {
    patchProp(el: HostElement, key: string, prevValue: any, nextValue: any, ns?: boolean, appContext?: AppContext | null): void;
    insert(child: HostNode, parent: HostElement, anchor?: HostNode | null): void;
    remove(child: HostNode): void;
    createElement(type: string, ns?: boolean, isCustomizedBuiltIn?: string): HostElement;
    createText(text: string): HostNode;
    createComment(text: string): HostNode;
    setText(node: HostNode, text: string): void;
    setElementText(node: HostElement, text: string): void;
    parentNode(node: HostNode): HostElement | null;
    nextSibling(node: HostNode): HostNode | null;
    querySelector?(selector: string): HostElement | null;
    setScopeId?(el: HostElement, id: string): void;
    cloneNode?(node: HostNode): HostNode;
    insertStaticContent?(content: string, parent: HostElement, anchor: HostNode | null, ns: boolean): [HostNode, HostNode];

    /**
     * Optional hook to handle `use:*` directive props.
     * Called by the core renderer for each `use:*` prop during mount and patch.
     * The platform renderer (e.g., runtime-dom) implements directive lifecycle logic here.
     * @param appContext - The current app context, used to resolve custom directives registered via `app.directive()`.
     */
    patchDirective?(el: HostElement, name: string, prevValue: any, nextValue: any, appContext: AppContext | null): void;

    /**
     * Optional hook called after an element is inserted into the DOM.
     * Used by runtime-dom for directive `mounted` lifecycle.
     */
    onElementMounted?(el: HostElement): void;

    /**
     * Optional hook called before an element is removed from the DOM.
     * Used by runtime-dom for directive `unmounted` lifecycle.
     */
    onElementUnmounted?(el: HostElement): void;

    /**
     * Optional hook to get the currently focused element.
     * Used to preserve focus across patch cycles.
     */
    getActiveElement?(): HostElement | null;

    /**
     * Optional hook to restore focus to a previously focused element.
     * Called after patching if the active element changed.
     */
    restoreFocus?(el: HostElement): void;

    /**
     * Optional hook resolving the host namespace flag for an element.
     * The flag is opaque to core: it is threaded through the tree walk,
     * cached on vnodes, and handed back to `createElement`/`patchProp` —
     * the platform defines its meaning (in runtime-dom it means "in the
     * SVG namespace"). `parentNS` is the parent element's flag, or
     * `undefined` when the surrounding context is unknown (hydrated
     * subtrees patched from the top) — hosts typically fall back to a
     * tag-name heuristic then. When absent, every element resolves to the
     * default namespace (`false`).
     */
    getElementNamespace?(tag: string, parentNS: boolean | undefined): boolean;

    /**
     * Optional hook resolving the namespace context the children of an
     * element inherit, given the element's own flag. Lets the host reset
     * the context at boundary elements (e.g. `foreignObject` in the DOM).
     * When absent, children inherit the element's flag unchanged.
     */
    getChildNamespace?(tag: string, ns: boolean): boolean;

    /**
     * Optional hook resolving the namespace context of the container of an
     * element, given the element's tag and cached flag. Used when replacing
     * a node whose surrounding context is unknown (e.g. in the DOM, an
     * SVG-namespace element that is not the `<svg>` root sits in an SVG
     * container). When absent, the container resolves to the default
     * namespace (`false`).
     */
    getContainerNamespace?(tag: string, ns: boolean): boolean;
}

export type RootRenderFunction<_HostNode = any, HostElement = any> = (
    vnode: JSXElement,
    container: HostElement,
    appContext?: AppContext
) => void;

/**
 * Function types for renderer operations exposed for plugins/hydration
 */
export type RendererMountFn<HostNode = any, HostElement = any> = (
    vnode: VNode,
    container: HostElement,
    before?: HostNode | null
) => void;

export type RendererUnmountFn<_HostNode = any, HostElement = any> = (
    vnode: VNode,
    container: HostElement
) => void;

export type RendererPatchFn<_HostNode = any, HostElement = any> = (
    n1: VNode,
    n2: VNode,
    container: HostElement
) => void;

export type RendererMountComponentFn<HostNode = any, HostElement = any> = (
    vnode: VNode,
    container: HostElement,
    before: HostNode | null,
    setup: SetupFn<any, any, any, any>
) => void;

/**
 * Renderer instance returned by createRenderer
 */
export interface Renderer<HostNode = any, HostElement = any> {
    render: RootRenderFunction<HostNode, HostElement>;
    patch: RendererPatchFn<HostNode, HostElement>;
    mount: RendererMountFn<HostNode, HostElement>;
    unmount: RendererUnmountFn<HostNode, HostElement>;
    mountComponent: RendererMountComponentFn<HostNode, HostElement>;
}
