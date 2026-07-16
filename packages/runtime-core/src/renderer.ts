import { VNode, Fragment, JSXElement, Text, Comment, EMPTY_PROPS } from './jsx-runtime.js';
import { effect, signal, untrack } from '@sigx/reactivity';
import { withoutOwnerTracking } from '@sigx/reactivity/internals';
import { ComponentSetupContext, setCurrentInstance, getCurrentInstance, MountContext, ViewFn, SetupFn } from './component.js';
import { createPropsAccessor } from './utils/props-accessor.js';
import { createSlots } from './utils/slots.js';
import { normalizeSubTree } from './utils/normalize.js';
import { applyContextExtensions } from './plugins.js';
import { isComponent } from './utils/is-component.js';
import { createEmit, splitComponentProps } from './utils/component-props.js';
import { provideAppContext } from './di/injectable.js';
import { isModel } from './model.js';
import { asyncSetupClientError } from './errors.js';
import { applyErrorScope } from './error-scope.js';
import { queueJob, nextJobId, type SchedulerJob } from './scheduler.js';
import {
    AppContext,
    ComponentInstance,
    notifyComponentCreated,
    notifyComponentMounted,
    notifyComponentUnmounted,
    notifyComponentUpdated,
    handleComponentError
} from './app.js';

// Re-export types and interfaces from renderer-types.ts
export type {
    InternalVNode,
    RendererOptions,
    RootRenderFunction,
    RendererMountFn,
    RendererUnmountFn,
    RendererPatchFn,
    RendererMountComponentFn,
    Renderer
} from './renderer-types.js';
import type { InternalVNode, RendererOptions, Renderer } from './renderer-types.js';

// isComponent is imported from ./utils/is-component.js and re-exported
export { isComponent } from './utils/is-component.js';

/**
 * Container element with internal VNode storage
 */
interface InternalContainer {
    _vnode?: VNode | null;
}

/**
 * Host node with back-reference to VNode
 */
interface InternalHostNode {
    __vnode?: VNode;
}

/**
 * Component factory function with setup and optional name
 */
interface ComponentFactory {
    __setup: SetupFn<any, any, any, any>;
    __name?: string;
}

/**
 * Internal component context with debug properties
 */
interface InternalComponentContext extends ComponentSetupContext {
    __name?: string;
}

// ============================================================================
// Pure utility functions (no closure dependencies)
// ============================================================================

function isSameVNode(n1: VNode, n2: VNode): boolean {
    if (n1.type !== n2.type) return false;
    const k1 = n1.key == null ? null : n1.key;
    const k2 = n2.key == null ? null : n2.key;
    if (k1 === k2) return true;
    // Identity failed: only a string/number cross-type pair can still
    // match (key coercion). Avoid the String() allocations on the hot
    // same-type and null cases — this runs O(n) per keyed diff pass.
    if (k1 === null || k2 === null || typeof k1 === typeof k2) return false;
    return String(k1) === String(k2);
}

/**
 * Conservative structural equality for slot content (raw `props.children`
 * values: vnodes, arrays, primitives). Used to elide the slot version
 * bump when a parent re-render passes identical slot content. MUST err
 * on the side of "different": any uncertainty returns false and the
 * child re-renders exactly as it always did. Fresh inline closures in
 * props make this return false naturally (`!==`), which is correct —
 * the new handler must reach the DOM.
 */
function sameSlotChildren(a: any, b: any): boolean {
    if (a === b) return true;
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray || bIsArray) {
        if (!aIsArray || !bIsArray || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!sameSlotChildren(a[i], b[i])) return false;
        }
        return true;
    }
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
        // primitives (and mismatched null/undefined): identity above was
        // the only acceptable equality
        return false;
    }
    // Only vnode-shaped objects can be compared structurally. Anything
    // else (state proxies, arbitrary user objects) is only equal by the
    // identity check above — comparing absent vnode fields would make
    // two DIFFERENT opaque objects look identical.
    if (a.type === undefined || b.type === undefined) return false;
    if (a.type !== b.type || a.key !== b.key || a.text !== b.text) return false;
    const aProps = a.props || EMPTY_PROPS;
    const bProps = b.props || EMPTY_PROPS;
    for (const k in aProps) {
        if (k === 'children') continue;
        if (aProps[k] !== bProps[k]) return false;
    }
    for (const k in bProps) {
        if (k === 'children') continue;
        if (!(k in aProps)) return false;
    }
    return sameSlotChildren(aProps.children, bProps.children)
        && sameSlotChildren(a.children, b.children);
}

const EMPTY_SEQUENCE: number[] = [];

/**
 * Longest increasing subsequence over `newIndexToOldIndexMap` values
 * (zeros — freshly mounted nodes — are ignored). Returns the INDICES of
 * the stable elements. O(n log n); the canonical implementation used by
 * Vue's keyed diff.
 */
function getSequence(arr: number[]): number[] {
    const p = arr.slice();
    const result = [0];
    let i: number, j: number, u: number, v: number, c: number;
    const len = arr.length;
    for (i = 0; i < len; i++) {
        const arrI = arr[i];
        if (arrI !== 0) {
            j = result[result.length - 1];
            if (arr[j] < arrI) {
                p[i] = j;
                result.push(i);
                continue;
            }
            u = 0;
            v = result.length - 1;
            while (u < v) {
                c = (u + v) >> 1;
                if (arr[result[c]] < arrI) {
                    u = c + 1;
                } else {
                    v = c;
                }
            }
            if (arrI < arr[result[u]]) {
                if (u > 0) {
                    p[i] = result[u - 1];
                }
                result[u] = i;
            }
        }
    }
    u = result.length;
    v = result[u - 1];
    while (u-- > 0) {
        result[u] = v;
        v = p[v];
    }
    return result;
}

/**
 * Check for duplicate keys in an array of VNodes and warn in development.
 */
function checkDuplicateKeys(children: VNode[]): void {
    if (!__DEV__) return;

    const seenKeys = new Set<string>();
    for (const child of children) {
        if (child?.key != null) {
            const key = child.key;
            const keyStr = typeof key === 'string' ? key : String(key);
            if (seenKeys.has(keyStr)) {
                console.warn(
                    `[SignalX] Duplicate key "${child.key}" detected in list. ` +
                    `Keys should be unique among siblings to ensure correct reconciliation. ` +
                    `This may cause unexpected behavior when items are reordered, added, or removed.`
                );
            }
            seenKeys.add(keyStr);
        }
    }
}

export function createRenderer<HostNode = any, HostElement = any>(
    options: RendererOptions<HostNode, HostElement>
): Renderer<HostNode, HostElement> {
    const {
        insert: hostInsert,
        remove: hostRemove,
        patchProp: hostPatchProp,
        createElement: hostCreateElement,
        createText: hostCreateText,
        createComment: hostCreateComment,
        setText: hostSetText,
        setElementText: _hostSetElementText,
        parentNode: hostParentNode,
        nextSibling: hostNextSibling,
        cloneNode: _hostCloneNode,
        insertStaticContent: _hostInsertStaticContent,
        patchDirective: hostPatchDirective,
        onElementMounted: hostOnElementMounted,
        onElementUnmounted: hostOnElementUnmounted,
        getActiveElement: hostGetActiveElement,
        restoreFocus: hostRestoreFocus,
        getElementNamespace: hostGetElementNamespace,
        getChildNamespace: hostGetChildNamespace,
        getContainerNamespace: hostGetContainerNamespace
    } = options;

    // Current app context (set when rendering via defineApp)
    let currentAppContext: AppContext | null = null;

    function render(element: JSXElement, container: HostElement, appContext?: AppContext): void {
        // Store app context for this render tree
        const _prevAppContext = currentAppContext;
        if (appContext) {
            currentAppContext = appContext;
        }

        const oldVNode = (container as unknown as InternalContainer)._vnode;

        // Normalize element to VNode if it's not
        let vnode: VNode | null = null;
        if (element != null && element !== false && element !== true) {
            if (typeof element === 'string' || typeof element === 'number') {
                vnode = {
                    type: Text,
                    props: {},
                    key: null,
                    children: [],
                    dom: null,
                    text: element
                };
            } else if (isComponent(element)) {
                // Handle component factory passed directly (e.g., defineApp(Counter))
                vnode = {
                    type: element as unknown as VNode['type'],
                    props: {},
                    key: null,
                    children: [],
                    dom: null
                };
            } else {
                vnode = element as VNode;
            }
        }

        if (vnode) {
            if (oldVNode) {
                patch(oldVNode, vnode, container);
            } else {
                mount(vnode, container);
            }
            (container as unknown as InternalContainer)._vnode = vnode;
        } else {
            if (oldVNode) {
                unmount(oldVNode, container);
                (container as unknown as InternalContainer)._vnode = null;
            }
        }
    }

    /**
     * Apply a ref value to a ref prop (function or object).
     * Wrapped in untrack() to prevent reactive loops when a ref handler
     * happens to write to a signal.
     */
    function applyRef(ref: any, value: any): void {
        if (!ref) return;
        untrack(() => {
            if (typeof ref === 'function') {
                ref(value);
            } else if (typeof ref === 'object') {
                ref.current = value;
            }
        });
    }

    /**
     * Reconcile a `ref` prop across a same-type patch. If the ref identity
     * changed, null the old ref and call the new ref with the current value.
     * Without this, ref swaps (e.g. `ref={cond() ? a : b}`) silently leave
     * the old ref holding a stale reference and never invoke the new one.
     */
    function updateRef(oldRef: any, newRef: any, value: any): void {
        if (oldRef === newRef) return;
        if (oldRef) applyRef(oldRef, null);
        if (newRef) applyRef(newRef, value);
    }

    function mount(vnode: VNode, container: HostElement, before: HostNode | null = null, parentNS: boolean = false): void {
        // Guard against null, undefined, boolean values (from conditional rendering)
        if (vnode == null || vnode === (false as unknown as VNode) || vnode === (true as unknown as VNode)) {
            return;
        }

        if (vnode.type === Text) {
            const node = hostCreateText(String(vnode.text));
            vnode.dom = node;
            (node as unknown as InternalHostNode).__vnode = vnode;
            hostInsert(node, container, before);
            return;
        }

        if (vnode.type === Comment) {
            const node = hostCreateComment('');
            vnode.dom = node;
            hostInsert(node, container, before);
            return;
        }

        if (vnode.type === Fragment) {
            // For fragments, we need a way to track the children's DOM nodes.
            // The anchor comment is inserted first and children are inserted
            // before it, so `vnode.dom` always points at the fragment's
            // trailing boundary. Reconciliation uses this anchor as the
            // fallback insertion point for appended children so they stay
            // within the fragment instead of being pushed past trailing
            // siblings in the parent DOM.
            const anchor = hostCreateComment('');
            vnode.dom = anchor;
            hostInsert(anchor, container, before);
            if (vnode.children) {
                const children = vnode.children;
                for (let i = 0; i < children.length; i++) {
                    mount(children[i], container, anchor, parentNS);
                }
            }
            return;
        }

        // Check for component (function with __setup)
        if (isComponent(vnode.type)) {
            mountComponent(vnode, container, before, vnode.type.__setup as SetupFn, parentNS);
            return;
        }

        // Resolve the element's host namespace flag. The flag is opaque to
        // core — the platform's namespace host ops define its meaning.
        // Without the ops, every element lives in the host's default
        // namespace.
        const tag = vnode.type as string;
        const ns = hostGetElementNamespace ? hostGetElementNamespace(tag, parentNS) : false;
        (vnode as InternalVNode)._ns = ns;

        const element = hostCreateElement(tag, ns);
        vnode.dom = element;
        (element as unknown as InternalHostNode).__vnode = vnode;

        // Props
        if (vnode.props) {
            for (const key in vnode.props) {
                if (key !== 'children' && key !== 'key' && key !== 'ref') {
                    if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                        // Delegate use:* directive props to the platform renderer
                        if (hostPatchDirective) {
                            hostPatchDirective(element, key.slice(4), null, vnode.props[key], currentAppContext);
                        }
                    } else {
                        hostPatchProp(element, key, null, vnode.props[key], ns, currentAppContext);
                    }
                }
            }

            // Handle ref - wrap in untrack to prevent reactive loops
            applyRef(vnode.props.ref, element);
        }

        // Children - pass the namespace context they inherit (the host may
        // reset it at boundary elements, e.g. foreignObject in the DOM)
        const childNS = hostGetChildNamespace ? hostGetChildNamespace(tag, ns) : ns;
        if (vnode.children) {
            const children = vnode.children;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                child.parent = vnode;
                mount(child, element, null, childNS);
            }
        }

        hostInsert(element as unknown as HostNode, container, before);

        // Invoke platform element lifecycle (e.g., directive mounted hooks in runtime-dom)
        if (hostOnElementMounted) {
            hostOnElementMounted(element);
        }
    }

    function unmount(vnode: VNode, container: HostElement): void {
        const internalVNode = vnode as InternalVNode;
        if (internalVNode._effect) {
            internalVNode._effect.stop(); // Stop effect
        }

        if (vnode.cleanup) {
            vnode.cleanup();
        }

        // Handle component unmount - unmount its subTree
        if (isComponent(vnode.type)) {
            // Use the shared subtree ref if available (handles stale _subTree after same-type patches)
            const subTree = internalVNode._subTreeRef?.current ?? internalVNode._subTree;
            if (subTree) {
                unmount(subTree, container);
            }
            // Remove the anchor comment
            if (vnode.dom) {
                hostRemove(vnode.dom);
            }
            // Handle ref cleanup - wrap in untrack to prevent reactive loops
            applyRef(vnode.props?.ref, null);
            return;
        }

        if (vnode.type === Fragment) {
            if (vnode.children) {
                const children = vnode.children;
                for (let i = 0; i < children.length; i++) {
                    unmount(children[i], container);
                }
            }
            // Remove anchor comment if exists
            if (vnode.dom) {
                hostRemove(vnode.dom);
            }
            return;
        }

        if (vnode.type === Comment) {
            if (vnode.dom) {
                hostRemove(vnode.dom);
            }
            return;
        }

        // Handle ref cleanup - wrap in untrack to prevent reactive loops
        applyRef(vnode.props?.ref, null);

        // Invoke platform element lifecycle (e.g., directive unmounted hooks in runtime-dom)
        if (hostOnElementUnmounted && vnode.dom) {
            hostOnElementUnmounted(vnode.dom);
        }

        // Recursively unmount children for regular elements
        if (vnode.children && vnode.children.length > 0) {
            const children = vnode.children;
            for (let i = 0; i < children.length; i++) {
                unmount(children[i], vnode.dom as HostElement);
            }
        }

        if (vnode.dom) {
            hostRemove(vnode.dom);
        }
    }

    function patch(oldVNode: VNode, newVNode: VNode, container: HostElement, parentNS: boolean | undefined = undefined): void {
        if (oldVNode === newVNode) return;

        // If types are different, replace completely
        if (!isSameVNode(oldVNode, newVNode)) {
            const parent = hostParentNode(oldVNode.dom) || container;
            // With unified trailing markers, vnode.dom is always the trailing anchor
            // so hostNextSibling gives us the correct insertion point
            const nextSibling = oldVNode.dom ? hostNextSibling(oldVNode.dom) : null;
            unmount(oldVNode, parent as HostElement);
            // Thread the namespace context so a replacement inside a
            // namespaced subtree keeps it. When the context is unknown, let
            // the host derive the container's context from the old element's
            // flag — resolving that flag first via the tag heuristic if the
            // old vnode was hydrated and never cached one.
            let containerNS: boolean;
            if (parentNS !== undefined) {
                containerNS = parentNS;
            } else if (typeof oldVNode.type === 'string' && hostGetContainerNamespace) {
                const oldNS = (oldVNode as InternalVNode)._ns ??
                    (hostGetElementNamespace ? hostGetElementNamespace(oldVNode.type, undefined) : false);
                containerNS = hostGetContainerNamespace(oldVNode.type, oldNS);
            } else {
                containerNS = false;
            }
            mount(newVNode, parent as HostElement, nextSibling, containerNS);
            return;
        }

        // If component
        const oldInternal = oldVNode as InternalVNode;
        const newInternal = newVNode as InternalVNode;
        if (oldInternal._effect) {
            newVNode.dom = oldVNode.dom;
            newInternal._effect = oldInternal._effect;
            newInternal._subTree = oldInternal._subTree;
            newInternal._subTreeRef = oldInternal._subTreeRef;
            newInternal._slots = oldInternal._slots;
            // Preserve the cleanup closure created during mountComponent.
            // It notifies plugins of unmount and runs the component's
            // unmountHooks; if we drop it here, the eventual unmount() finds
            // vnode.cleanup === undefined and onUnmounted hooks never fire.
            newVNode.cleanup = oldVNode.cleanup;
            // Preserve the exposed-value snapshot so a later ref change can
            // hand the new ref the same value the original mount captured.
            newInternal._exposed = oldInternal._exposed;

            const props = oldInternal._componentProps;
            newInternal._componentProps = props;

            if (props) {
                const newProps = newVNode.props || {};
                const newModels = newVNode.props?.$models || {};

                // Update props (excluding children, key, ref, $models).
                // Reads through `props[key]` trigger the proxy GET trap,
                // which lazily wraps object values in nested reactive
                // signals. Wrapping this in `withoutOwnerTracking`
                // prevents those framework-internal sub-signals from
                // being attributed to whichever component's render
                // effect is currently running (the parent's). Every
                // re-render that passes a fresh Model object would
                // otherwise leak a phantom signal into the parent.
                untrack(() => withoutOwnerTracking(() => {
                    for (const key in newProps) {
                        if (key !== "children" && key !== "key" && key !== "ref" && key !== "$models") {
                            if (props[key] !== newProps[key]) {
                                props[key] = newProps[key];
                            }
                        }
                    }

                    // Merge updated Model objects into props
                    // Only update if the binding changed (different obj or key)
                    for (const modelKey in newModels) {
                        const newModel = newModels[modelKey];
                        const oldModel = props[modelKey];
                        if (isModel(newModel)) {
                            // Skip update if binding is the same (same obj and key)
                            if (isModel(oldModel)) {
                                const [newObj, newKey] = newModel.binding;
                                const [oldObj, oldKey] = oldModel.binding;
                                if (newObj === oldObj && newKey === oldKey) {
                                    continue; // Same binding, reuse old Model
                                }
                            }
                            props[modelKey] = newModel;
                        }
                    }

                    // Handle removed props (optional but good)
                    for (const key in props) {
                        if (!(key in newProps) && !(key in newModels) && key !== "children" && key !== "key" && key !== "ref" && key !== "$models") {
                            delete props[key];
                        }
                    }
                }));
            }

            // Update slots with new children and slot functions
            const slotsRef = oldInternal._slots;
            const newChildren = newVNode.props?.children;
            const newSlotsFromProps = newVNode.props?.slots;

            if (slotsRef) {
                let slotContentChanged = false;

                // Update children for default slot — only when the new
                // content structurally differs. On equality we keep the
                // OLD vnodes (the ones the child's mounted subtree
                // references) and skip the version bump entirely, so a
                // parent-only re-render no longer forces every child
                // with static slot content to re-render.
                if (newChildren !== undefined) {
                    if (sameSlotChildren(slotsRef._children, newChildren)) {
                        // keep mounted originals
                    } else {
                        slotsRef._children = newChildren;
                        slotContentChanged = true;
                    }
                }

                // Update slot functions from the slots prop. Function
                // identity is the only cheap safe signal here: inline
                // slot objects/closures always differ and always bump.
                if (newSlotsFromProps !== undefined) {
                    if (slotsRef._slotsFromProps !== newSlotsFromProps) {
                        slotsRef._slotsFromProps = newSlotsFromProps;
                        slotContentChanged = true;
                    }
                }

                // Trigger component re-render by bumping version
                // Use per-component flag to prevent infinite loops on the SAME component
                // but allow nested components to update
                if (slotContentChanged && !slotsRef._isPatching) {
                    slotsRef._isPatching = true;
                    try {
                        untrack(() => {
                            slotsRef._version.v++;
                        });
                    } finally {
                        slotsRef._isPatching = false;
                    }
                }
            }

            // Reconcile ref changes AFTER props/slots are updated so the new ref
            // callback observes a component whose props reflect the latest patch.
            // The prop-diff loop above excludes 'ref', so we handle it here.
            updateRef(oldVNode.props?.ref, newVNode.props?.ref, oldInternal._exposed);

            return;
        }

        // If text node
        if (newVNode.type === Text) {
            newVNode.dom = oldVNode.dom;
            
            // Guard: if old text node has no DOM (can happen during hydration mismatch),
            // create a fresh text node instead of crashing
            if (!newVNode.dom) {
                const textNode = hostCreateText(String(newVNode.text));
                newVNode.dom = textNode;
                // Try to insert into container if possible
                if (container) {
                    hostInsert(textNode, container, oldVNode.dom || null);
                }
                return;
            }
            
            if (oldVNode.text !== newVNode.text) {
                hostSetText(newVNode.dom, String(newVNode.text));
            }
            return;
        }

        // If Comment — just transfer the DOM reference (comments are identity-less)
        if (newVNode.type === Comment) {
            newVNode.dom = oldVNode.dom;
            return;
        }

        // If Fragment
        if (newVNode.type === Fragment) {
            // Carry over the trailing anchor comment so the reconciler can
            // use it as a fallback insertion target when appending new
            // children that have no following sibling VNode.
            newVNode.dom = oldVNode.dom;
            patchChildren(oldVNode, newVNode, container, parentNS, newVNode.dom ?? null);
            return;
        }

        // Element
        const element = (newVNode.dom = oldVNode.dom) as HostElement;
        
        // Guard: if old element has no DOM (can happen with hydrated slot content),
        // recover by mounting fresh instead of crashing
        if (!element) {
            mount(newVNode, container, null, parentNS);
            return;
        }
        
        // Resolve the element's host namespace flag (for proper attribute
        // handling). Prefer the flag cached at mount — it is contextual, so
        // the host can disambiguate tags that exist in several namespaces.
        // Hydrated vnodes lack the flag until their first patch; ask the
        // host to resolve it from the threaded context — undefined at the
        // top of a subtree patched without context, a real flag once an
        // ancestor has been resolved — then cache forward.
        const tag = newVNode.type as string;
        const ns = (newVNode as InternalVNode)._ns =
            (oldVNode as InternalVNode)._ns ??
            (hostGetElementNamespace ? hostGetElementNamespace(tag, parentNS) : false);

        // Update props — skipped entirely when both sides share the same
        // props object (prop-less elements share EMPTY_PROPS). Compare the
        // RAW references first: substituting fresh `{}` for a missing props
        // object would make the identity guard never fire.
        const oldProps = oldVNode.props || EMPTY_PROPS;
        const newProps = newVNode.props || EMPTY_PROPS;

        if (oldProps !== newProps) {
            // Remove old props
            for (const key in oldProps) {
                if (!(key in newProps) && key !== 'children' && key !== 'key' && key !== 'ref') {
                    if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                        if (hostPatchDirective) {
                            hostPatchDirective(element, key.slice(4), oldProps[key], null, currentAppContext);
                        }
                    } else {
                        hostPatchProp(element, key, oldProps[key], null, ns, currentAppContext);
                    }
                }
            }

            // Set new props
            for (const key in newProps) {
                const oldValue = oldProps[key];
                const newValue = newProps[key];
                if (key !== 'children' && key !== 'key' && key !== 'ref' && oldValue !== newValue) {
                    if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                        if (hostPatchDirective) {
                            hostPatchDirective(element, key.slice(4), oldValue, newValue, currentAppContext);
                        }
                    } else {
                        hostPatchProp(element, key, oldValue, newValue, ns, currentAppContext);
                    }
                }
            }
        }

        // Reconcile ref changes (function or object swap, add, or removal) AFTER
        // props are applied so the new ref callback observes the updated element.
        // The prop loops above exclude 'ref', so we handle it here.
        updateRef(oldProps.ref, newProps.ref, element);

        // Update children - pass the namespace context they inherit
        const childNS = hostGetChildNamespace ? hostGetChildNamespace(tag, ns) : ns;
        patchChildren(oldVNode, newVNode, element, childNS);
    }

    function patchChildren(oldVNode: VNode, newVNode: VNode, container: HostElement, parentNS: boolean | undefined = undefined, fallbackAnchor: HostNode | null = null) {
        const oldChildren = oldVNode.children;
        const newChildren = newVNode.children;

        // Fast path: exactly one same-vnode child on both sides (the dominant
        // <li>text</li> shape). patch() handles it directly — including the
        // Text branch's hostSetText — skipping the reconcile machinery and
        // the dev-mode duplicate-key scan (vacuous for a single child).
        if (oldChildren.length === 1 && newChildren.length === 1) {
            const oldChild = oldChildren[0];
            const newChild = newChildren[0];
            if (oldChild != null && newChild != null && isSameVNode(oldChild, newChild)) {
                newChild.parent = newVNode;
                patch(oldChild, newChild, container, parentNS);
                return;
            }
        }

        for (let i = 0; i < newChildren.length; i++) {
            newChildren[i].parent = newVNode;
        }

        reconcileChildrenArray(container, oldChildren, newChildren, parentNS, fallbackAnchor);
    }

    /**
     * First host node a vnode's rendered range occupies. For elements,
     * text and comments this is `vnode.dom`; for Fragments the first
     * child's first node (falling back to the trailing anchor when
     * empty); for components the subtree's first node, falling back to
     * the component's trailing anchor comment. Used to compute insertion
     * anchors that don't land inside a fragment/component sibling's span.
     */
    function firstHostNode(vnode: VNode | null | undefined): HostNode | null {
        if (vnode == null) return null;
        if (vnode.type === Fragment) {
            const children = vnode.children;
            for (let i = 0; i < children.length; i++) {
                const n = firstHostNode(children[i]);
                if (n) return n;
            }
            return (vnode.dom as HostNode) ?? null;
        }
        if (isComponent(vnode.type)) {
            const internal = vnode as InternalVNode;
            const sub = internal._subTreeRef?.current ?? internal._subTree;
            return (sub ? firstHostNode(sub) : null) ?? ((vnode.dom as HostNode) ?? null);
        }
        return (vnode.dom as HostNode) ?? null;
    }

    /**
     * Move a vnode's ENTIRE host range before `anchor`. For fragments and
     * components `vnode.dom` is the trailing anchor comment — moving only
     * it (what the old diff did) left the content behind.
     */
    function moveVNode(vnode: VNode | null | undefined, parent: HostElement, anchor: HostNode | null): void {
        if (vnode == null) return;
        if (vnode.type === Fragment) {
            const children = vnode.children;
            for (let i = 0; i < children.length; i++) {
                moveVNode(children[i], parent, anchor);
            }
            if (vnode.dom) hostInsert(vnode.dom as HostNode, parent, anchor);
            return;
        }
        if (isComponent(vnode.type)) {
            const internal = vnode as InternalVNode;
            const sub = internal._subTreeRef?.current ?? internal._subTree;
            if (sub) moveVNode(sub, parent, anchor);
            if (vnode.dom) hostInsert(vnode.dom as HostNode, parent, anchor);
            return;
        }
        if (vnode.dom) hostInsert(vnode.dom as HostNode, parent, anchor);
    }

    /**
     * Keyed children reconciliation (Vue-3-style): prefix/suffix sync,
     * then a keyed middle pass whose moves are minimized with a longest-
     * increasing-subsequence — only nodes outside the stable subsequence
     * are moved, and fragment/component children move their whole host
     * range (via moveVNode), not just their trailing anchor.
     */
    function reconcileChildrenArray(parent: HostElement, oldChildren: VNode[], newChildren: VNode[], parentNS: boolean | undefined = undefined, fallbackAnchor: HostNode | null = null) {
        // Check for duplicate keys in development
        if (__DEV__) {
            checkDuplicateKeys(newChildren);
        }

        let i = 0;
        let e1 = oldChildren.length - 1;
        let e2 = newChildren.length - 1;

        // 1. Prefix sync. Old arrays may contain holes; a hole ends the run.
        while (i <= e1 && i <= e2) {
            const n1 = oldChildren[i];
            if (n1 != null && isSameVNode(n1, newChildren[i])) {
                patch(n1, newChildren[i], parent, parentNS);
                i++;
            } else {
                break;
            }
        }

        // 2. Suffix sync.
        while (i <= e1 && i <= e2) {
            const n1 = oldChildren[e1];
            if (n1 != null && isSameVNode(n1, newChildren[e2])) {
                patch(n1, newChildren[e2], parent, parentNS);
                e1--;
                e2--;
            } else {
                break;
            }
        }

        // 3. Old range exhausted: mount the remaining new range before the
        //    already-patched suffix head, falling back to the enclosing
        //    fragment's trailing anchor (never bare-append past siblings
        //    that follow the fragment in the parent DOM).
        if (i > e1) {
            if (i <= e2) {
                const next = e2 + 1 < newChildren.length ? firstHostNode(newChildren[e2 + 1]) : null;
                const anchor = next ?? fallbackAnchor ?? null;
                for (; i <= e2; i++) {
                    mount(newChildren[i], parent, anchor, parentNS);
                }
            }
            return;
        }

        // 4. New range exhausted: unmount the remaining old range.
        if (i > e2) {
            for (; i <= e1; i++) {
                const n1 = oldChildren[i];
                if (n1 != null) {
                    unmount(n1, parent);
                }
            }
            return;
        }

        // 5. Middle: map new keys, then walk the old range once — patching
        //    matches, unmounting the rest, and detecting whether anything
        //    actually moved.
        const s2 = i;
        const keyToNewIndexMap = new Map<string, number>();
        for (let j = s2; j <= e2; j++) {
            const key = newChildren[j].key;
            if (key != null) {
                keyToNewIndexMap.set(typeof key === 'string' ? key : String(key), j);
            }
        }

        const toBePatched = e2 - s2 + 1;
        let patched = 0;
        let moved = false;
        let maxNewIndexSoFar = 0;
        // newIndexToOldIndexMap[newIndex - s2] = oldIndex + 1 (0 = mount fresh)
        const newIndexToOldIndexMap: number[] = Array.from({ length: toBePatched }, () => 0);

        for (let j = i; j <= e1; j++) {
            const prevChild = oldChildren[j];
            if (prevChild == null) continue;
            if (patched >= toBePatched) {
                unmount(prevChild, parent);
                continue;
            }
            let newIndex: number | undefined;
            const prevKey = prevChild.key;
            if (prevKey != null) {
                newIndex = keyToNewIndexMap.get(typeof prevKey === 'string' ? prevKey : String(prevKey));
                // Same key but different type must remount, not patch.
                if (newIndex !== undefined && !isSameVNode(prevChild, newChildren[newIndex])) {
                    newIndex = undefined;
                }
            } else {
                // Keyless fallback: first unclaimed same-type keyless new
                // child (covers mixed keyed/unkeyed siblings and the
                // Comment placeholders normalizeChild emits).
                for (let k = s2; k <= e2; k++) {
                    if (newIndexToOldIndexMap[k - s2] === 0 && isSameVNode(prevChild, newChildren[k])) {
                        newIndex = k;
                        break;
                    }
                }
            }
            if (newIndex === undefined) {
                unmount(prevChild, parent);
            } else {
                newIndexToOldIndexMap[newIndex - s2] = j + 1;
                if (newIndex >= maxNewIndexSoFar) {
                    maxNewIndexSoFar = newIndex;
                } else {
                    moved = true;
                }
                patch(prevChild, newChildren[newIndex], parent, parentNS);
                patched++;
            }
        }

        // 6. Backward walk: mount fresh nodes and move only the nodes
        //    outside the longest increasing subsequence of old positions.
        const stable = moved ? getSequence(newIndexToOldIndexMap) : EMPTY_SEQUENCE;
        let s = stable.length - 1;
        for (let j = toBePatched - 1; j >= 0; j--) {
            const newIndex = s2 + j;
            const next = newIndex + 1 < newChildren.length ? firstHostNode(newChildren[newIndex + 1]) : null;
            const anchor = next ?? fallbackAnchor ?? null;
            if (newIndexToOldIndexMap[j] === 0) {
                mount(newChildren[newIndex], parent, anchor, parentNS);
            } else if (moved) {
                if (s < 0 || j !== stable[s]) {
                    moveVNode(newChildren[newIndex], parent, anchor);
                } else {
                    s--;
                }
            }
        }
    }

    function mountComponent(vnode: VNode, container: HostElement, before: HostNode | null, setup: SetupFn<any, any, any, any>, parentNS: boolean = false) {
        // No wrapper element - we render directly into the container
        // Use an anchor comment to track the component's position
        const anchor = hostCreateComment('');
        vnode.dom = anchor; // The anchor serves as the component's "DOM" marker
        (anchor as unknown as InternalHostNode).__vnode = vnode;
        hostInsert(anchor, container, before);

        let exposed: any = null;
        let exposeCalled = false;

        const initialProps = vnode.props || {};
        const { children, slotsFromProps, propsWithModels } = splitComponentProps(initialProps);
        
        // Wrap renderer-internal reactives so the devtools owner
        // attribution isn't polluted by the parent's render effect.
        // Without this, every re-mount of a child leaks fresh signals
        // into whichever component is currently rendering.
        const reactiveProps = withoutOwnerTracking(() => signal(propsWithModels));
        const internalVNode = vnode as InternalVNode;
        internalVNode._componentProps = reactiveProps;

        // Create slots object from children and the slots prop
        const slots = withoutOwnerTracking(() => createSlots(children, slotsFromProps));
        internalVNode._slots = slots;

        // Lifecycle hook lists are null until a hook is actually
        // registered: most components register none, and four empty
        // arrays per instance add up in component-heavy trees.
        let createdHooks: (() => void)[] | null = null;
        let mountHooks: ((ctx: MountContext) => void)[] | null = null;
        let updatedHooks: (() => void)[] | null = null;
        let unmountHooks: ((ctx: MountContext) => void)[] | null = null;

        // Capture the parent component context BEFORE creating the new one
        // This is crucial for Provide/Inject to work
        const parentInstance = getCurrentInstance();

        // Get component name from the factory (if set via options)
        const componentFactory = vnode.type as unknown as ComponentFactory;
        const componentName = componentFactory.__name;

        // Create props accessor with defaults support
        const propsAccessor = createPropsAccessor(reactiveProps);

        const ctx = {
            el: container, // The parent container (since we don't have a wrapper)
            signal: signal,
            props: propsAccessor,
            slots: slots,
            emit: createEmit(reactiveProps),
            parent: parentInstance, // Link to parent for DI traversal
            onMounted: (fn: (ctx: MountContext) => void) => { (mountHooks ??= []).push(fn); },
            onUnmounted: (fn: (ctx: MountContext) => void) => { (unmountHooks ??= []).push(fn); },
            onCreated: (fn: () => void) => { (createdHooks ??= []).push(fn); },
            onUpdated: (fn: () => void) => { (updatedHooks ??= []).push(fn); },
            expose: (exposedValue: any) => {
                exposed = exposedValue;
                exposeCalled = true;
            },
            renderFn: null, // Will be set after setup returns
            update: () => { } // Placeholder, will be set after effect is created
        } as unknown as ComponentSetupContext;

        // Apply context extensions from plugins (e.g., SSR helper)
        applyContextExtensions(ctx);

        // Store the component name on the context for debugging
        (ctx as InternalComponentContext).__name = componentName;

        // For ROOT component only (no parent), provide the AppContext
        // This enables the DI system to find app-level provides by traversing up the tree
        if (!parentInstance && currentAppContext) {
            provideAppContext(ctx, currentAppContext);
        }

        // Create component instance info for lifecycle hooks
        const componentInstance: ComponentInstance = {
            name: componentName,
            ctx,
            vnode
        };

        const prev = setCurrentInstance(ctx);
        let renderFn: ViewFn | undefined;
        try {
            // Untracked: mounting happens inside the parent's render effect,
            // so without this every reactive read in a descendant's setup
            // would register as a PARENT dependency — a later write to any
            // such signal re-renders the parent, remounts descendants, and
            // the flush can re-queue itself forever (#111). Reactivity in
            // setup belongs to explicit watch/computed/render scopes only.
            const setupResult = untrack(() => setup(ctx));
            // Async setup is only supported on server - check for promise
            if (setupResult && typeof (setupResult as any).then === 'function') {
                throw asyncSetupClientError(componentName ?? 'anonymous');
            }
            renderFn = setupResult as ViewFn;
            // Notify plugins that component was created (setup completed)
            notifyComponentCreated(currentAppContext, componentInstance);
            // Run component-level created hooks (untracked like setup and
            // the mount hooks below: they execute inside the parent's
            // render effect, so reads must not become parent deps, #111)
            if (createdHooks) {
                // Snapshot the length: hooks registered while running must
                // not run in this phase (historical forEach semantics).
                const hooks: (() => void)[] = createdHooks;
                untrack(() => {
                    for (let i = 0, len = hooks.length; i < len; i++) hooks[i]();
                });
            }
        } catch (err) {
            // Handle setup errors
            const handled = handleComponentError(currentAppContext, err as Error, componentInstance, 'setup');
            if (!handled) {
                throw err;
            }
        } finally {
            setCurrentInstance(prev);
        }

        // Handle ref - wrap in untrack to prevent reactive loops
        const refValue = exposeCalled ? exposed : null;
        internalVNode._exposed = refValue;
        applyRef(vnode.props?.ref, refValue);

        if (renderFn) {
            // errorScope() marked the ctx during setup — wrap the render fn
            // so the subtree renders under the scope's fallback/keyed view.
            renderFn = applyErrorScope(ctx, renderFn);
            ctx.renderFn = renderFn;

            // Shared mutable ref for the current subtree.
            // This ensures that when same-type patching replaces the VNode,
            // the effect closure and all aliased VNodes share the same subtree reference.
            const subTreeRef: { current: VNode | null } = { current: null };
            internalVNode._subTreeRef = subTreeRef;

            // Route re-renders through the render queue: one job per
            // component, deduped per notification wave, parents before
            // children (mount-order id). The first render stays inline.
            let scheduledRun: (() => void) | undefined;
            const renderJob: SchedulerJob = Object.assign(
                () => { if (scheduledRun) scheduledRun(); },
                { id: nextJobId() }
            );

            const componentEffect = effect(() => {
                // Set current instance during render so child components can find their parent
                const prevInstance = setCurrentInstance(ctx);
                try {
                    const subTreeResult = ctx.renderFn!();
                    if (subTreeResult == null) {
                        // If render returns null, unmount any existing subtree
                        // to prevent stale content from remaining in the DOM.
                        if (subTreeRef.current) {
                            unmount(subTreeRef.current, container);
                            subTreeRef.current = null;
                            internalVNode._subTree = null;
                        }
                        return;
                    }

                    // Handle arrays (fragments) or single vnodes
                    const subTree = normalizeSubTree(subTreeResult);
                    const prevSubTree = subTreeRef.current;

                    if (prevSubTree) {
                        // Preserve focused element across the entire patch cycle
                        const prevFocus = hostGetActiveElement ? hostGetActiveElement() : null;
                        patch(prevSubTree, subTree, container, parentNS);
                        if (prevFocus && hostRestoreFocus && hostGetActiveElement!() !== prevFocus) {
                            hostRestoreFocus(prevFocus);
                        }
                        // Notify plugins of component update (re-render)
                        notifyComponentUpdated(currentAppContext, componentInstance);
                        // Run component-level updated hooks
                        if (updatedHooks) {
                            const hooks: (() => void)[] = updatedHooks;
                            for (let i = 0, len = hooks.length; i < len; i++) hooks[i]();
                        }
                    } else {
                        mount(subTree, container, anchor, parentNS);
                    }
                    subTreeRef.current = subTree;
                    internalVNode._subTree = subTree;
                } catch (err) {
                    // Handle render errors
                    const handled = handleComponentError(currentAppContext, err as Error, componentInstance, 'render');
                    if (!handled) {
                        throw err;
                    }
                } finally {
                    setCurrentInstance(prevInstance);
                }
            }, {
                scheduler: (run) => {
                    scheduledRun = run;
                    queueJob(renderJob);
                },
            });
            internalVNode._effect = componentEffect;

            // Implement update() - re-runs the current render function
            // For HMR: set ctx.renderFn first, then call update()
            ctx.update = () => {
                componentEffect();
            };

            // HMR reload primitive (dev-only; stripped from the prod dist).
            // Re-runs a new setup body against THIS instance without a full
            // remount, replacing — not appending to — the previous run's
            // lifecycle registrations. Mirrors the initial-mount sequence so
            // resources the new setup creates in onCreated/onMounted are
            // re-established (a pure reset would tear the old ones down and
            // never re-create them). See core#107.
            if (__DEV__) {
                (ctx as InternalComponentContext).__hmrReload = (newSetup: SetupFn<any, any, any, any>) => {
                    // 1. Dispose the previous run's cleanups (untracked, like
                    //    the real unmount path) so old listeners/timers go away.
                    if (unmountHooks) {
                        const hooks: ((c: MountContext) => void)[] = unmountHooks;
                        untrack(() => {
                            for (let i = 0, len = hooks.length; i < len; i++) hooks[i](mountCtx);
                        });
                    }
                    // 2. Clear every hook list — the re-run repopulates them,
                    //    so hooks no longer accumulate across hot updates.
                    createdHooks = mountHooks = updatedHooks = unmountHooks = null;

                    // 3. Re-run the new setup exactly like mount: untracked
                    //    (no parent-dep capture, #111), instance current so
                    //    module-level hooks register here (#105), then rewrap
                    //    with the error scope and fire the new created hooks.
                    const prevInstance = setCurrentInstance(ctx);
                    try {
                        const setupResult = untrack(() => newSetup(ctx));
                        if (setupResult && typeof (setupResult as any).then === 'function') {
                            throw asyncSetupClientError(componentName ?? 'anonymous');
                        }
                        ctx.renderFn = applyErrorScope(ctx, setupResult as ViewFn);
                        if (createdHooks) {
                            const hooks: (() => void)[] = createdHooks;
                            untrack(() => {
                                for (let i = 0, len = hooks.length; i < len; i++) hooks[i]();
                            });
                        }
                    } finally {
                        setCurrentInstance(prevInstance);
                    }

                    // 4. Re-render through the existing effect (runs the new
                    //    updatedHooks and notifies plugins of the update).
                    componentEffect();

                    // 5. Fire the new mount hooks (untracked, like initial
                    //    mount) so onMounted-created resources are re-attached.
                    if (mountHooks) {
                        const hooks: ((c: MountContext) => void)[] = mountHooks;
                        untrack(() => {
                            for (let i = 0, len = hooks.length; i < len; i++) hooks[i](mountCtx);
                        });
                    }
                };
            }
        }

        // Run mount hooks (untrack to prevent signal reads from
        // polluting the parent component's reactive subscriptions)
        const mountCtx = { el: container } as MountContext;
        if (mountHooks) {
            const hooks: ((ctx: MountContext) => void)[] = mountHooks;
            untrack(() => {
                for (let i = 0, len = hooks.length; i < len; i++) hooks[i](mountCtx);
            });
        }

        // Notify plugins that component was mounted
        notifyComponentMounted(currentAppContext, componentInstance);

        // Store cleanup hooks on vnode for unmount
        vnode.cleanup = () => {
            // Notify plugins that component is being unmounted
            notifyComponentUnmounted(currentAppContext, componentInstance);
            if (unmountHooks) {
                const hooks: ((ctx: MountContext) => void)[] = unmountHooks;
                for (let i = 0, len = hooks.length; i < len; i++) hooks[i](mountCtx as MountContext);
            }
        };
    }

    // createSlots and normalizeSubTree are now imported from component-helpers.ts

    return {
        render,
        patch,
        mount,
        unmount,
        mountComponent
    };
}
