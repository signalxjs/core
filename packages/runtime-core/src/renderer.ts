import { VNode, Fragment, JSXElement, Text, Comment } from './jsx-runtime.js';
import { effect, signal, untrack, EffectRunner } from '@sigx/reactivity';
import { withoutOwnerTracking } from '@sigx/reactivity/internals';
import { ComponentSetupContext, setCurrentInstance, getCurrentInstance, MountContext, ViewFn, SetupFn } from './component.js';
import { createPropsAccessor } from './utils/props-accessor.js';
import { createSlots } from './utils/slots.js';
import { normalizeSubTree } from './utils/normalize.js';
import { applyContextExtensions } from './plugins.js';
import { isComponent } from './utils/is-component.js';
import { createEmit } from './hydration/index.js';
import { provideAppContext } from './di/injectable.js';
import { isModel } from './model.js';
import { asyncSetupClientError } from './errors.js';
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
    const k1 = n1.key == null ? null : n1.key;
    const k2 = n2.key == null ? null : n2.key;
    if (n1.type !== n2.type) return false;
    if (k1 === k2) return true;

    return String(k1) === String(k2);
}

function createKeyToKeyIndexMap(children: VNode[], beginIdx: number, endIdx: number) {
    const map = new Map<string | number, number>();
    for (let i = beginIdx; i <= endIdx; i++) {
        const key = children[i]?.key;
        if (key != null) {
            const keyStr = String(key);
            if (process.env.NODE_ENV !== 'production' && map.has(keyStr)) {
                console.warn(
                    `[SignalX] Duplicate key "${key}" detected in list. ` +
                    `Keys should be unique among siblings to ensure correct reconciliation. ` +
                    `This may cause unexpected behavior when items are reordered, added, or removed.`
                );
            }
            map.set(keyStr, i);
        }
    }
    return map;
}

function findIndexInOld(children: VNode[], newChild: VNode, beginIdx: number, endIdx: number): number | null {
    for (let i = beginIdx; i <= endIdx; i++) {
        if (children[i] && isSameVNode(children[i], newChild)) return i;
    }
    return null;
}

/**
 * Check for duplicate keys in an array of VNodes and warn in development.
 */
function checkDuplicateKeys(children: VNode[]): void {
    if (process.env.NODE_ENV === 'production') return;
    
    const seenKeys = new Set<string>();
    for (const child of children) {
        if (child?.key != null) {
            const keyStr = String(child.key);
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
        restoreFocus: hostRestoreFocus
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

    // SVG elements that should be created with createElementNS
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

    function isSvgTag(tag: string): boolean {
        return svgTags.has(tag);
    }
    function mount(vnode: VNode, container: HostElement, before: HostNode | null = null, parentIsSVG: boolean = false): void {
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
                vnode.children.forEach((child: VNode) => mount(child, container, anchor, parentIsSVG));
            }
            return;
        }

        // Check for component (function with __setup)
        if (isComponent(vnode.type)) {
            mountComponent(vnode, container, before, vnode.type.__setup as SetupFn);
            return;
        }

        // Determine if this element should be created as SVG
        const tag = vnode.type as string;
        const isSVG = tag === 'svg' || (parentIsSVG && tag !== 'foreignObject');

        const element = hostCreateElement(tag, isSVG);
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
                        hostPatchProp(element, key, null, vnode.props[key], isSVG);
                    }
                }
            }

            // Handle ref - wrap in untrack to prevent reactive loops
            if (vnode.props.ref) {
                untrack(() => {
                    if (typeof vnode.props.ref === 'function') {
                        vnode.props.ref(element);
                    } else if (typeof vnode.props.ref === 'object') {
                        vnode.props.ref.current = element;
                    }
                });
            }
        }

        // Children - pass SVG context (reset for foreignObject)
        const childIsSVG = isSVG && tag !== 'foreignObject';
        if (vnode.children) {
            vnode.children.forEach((child: VNode) => {
                child.parent = vnode;
                mount(child, element, null, childIsSVG)
            });
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
            if (vnode.props?.ref) {
                untrack(() => {
                    if (typeof vnode.props.ref === 'function') {
                        vnode.props.ref(null);
                    } else if (typeof vnode.props.ref === 'object') {
                        vnode.props.ref.current = null;
                    }
                });
            }
            return;
        }

        if (vnode.type === Fragment) {
            if (vnode.children) {
                vnode.children.forEach((child: VNode) => unmount(child, container));
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
        if (vnode.props?.ref) {
            untrack(() => {
                if (typeof vnode.props.ref === 'function') {
                    vnode.props.ref(null);
                } else if (vnode.props.ref && typeof vnode.props.ref === 'object') {
                    vnode.props.ref.current = null;
                }
            });
        }

        // Invoke platform element lifecycle (e.g., directive unmounted hooks in runtime-dom)
        if (hostOnElementUnmounted && vnode.dom) {
            hostOnElementUnmounted(vnode.dom);
        }

        // Recursively unmount children for regular elements
        if (vnode.children && vnode.children.length > 0) {
            vnode.children.forEach((child: VNode) => unmount(child, vnode.dom as HostElement));
        }

        if (vnode.dom) {
            hostRemove(vnode.dom);
        }
    }

    function patch(oldVNode: VNode, newVNode: VNode, container: HostElement): void {
        if (oldVNode === newVNode) return;

        // If types are different, replace completely
        if (!isSameVNode(oldVNode, newVNode)) {
            const parent = hostParentNode(oldVNode.dom) || container;
            // With unified trailing markers, vnode.dom is always the trailing anchor
            // so hostNextSibling gives us the correct insertion point
            const nextSibling = oldVNode.dom ? hostNextSibling(oldVNode.dom) : null;
            unmount(oldVNode, parent as HostElement);
            mount(newVNode, parent as HostElement, nextSibling);
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
                // Update children for default slot
                if (newChildren !== undefined) {
                    slotsRef._children = newChildren;
                }

                // Update slot functions from the slots prop
                if (newSlotsFromProps !== undefined) {
                    slotsRef._slotsFromProps = newSlotsFromProps;
                }

                // Trigger component re-render by bumping version
                // Use per-component flag to prevent infinite loops on the SAME component
                // but allow nested components to update
                if (!slotsRef._isPatching) {
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
            patchChildren(oldVNode, newVNode, container, false, newVNode.dom ?? null);
            return;
        }

        // Element
        const element = (newVNode.dom = oldVNode.dom) as HostElement;
        
        // Guard: if old element has no DOM (can happen with hydrated slot content),
        // recover by mounting fresh instead of crashing
        if (!element) {
            mount(newVNode, container);
            return;
        }
        
        // Determine if this is an SVG element (for proper attribute handling)
        const tag = newVNode.type as string;
        const isSVG = tag === 'svg' || isSvgTag(tag);

        // Update props
        const oldProps = oldVNode.props || {};
        const newProps = newVNode.props || {};

        // Remove old props
        for (const key in oldProps) {
            if (!(key in newProps) && key !== 'children' && key !== 'key' && key !== 'ref') {
                if (key.charCodeAt(0) === 117 /* 'u' */ && key.startsWith('use:')) {
                    if (hostPatchDirective) {
                        hostPatchDirective(element, key.slice(4), oldProps[key], null, currentAppContext);
                    }
                } else {
                    hostPatchProp(element, key, oldProps[key], null, isSVG);
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
                    hostPatchProp(element, key, oldValue, newValue, isSVG);
                }
            }
        }

        // Update children - pass SVG context for child elements (reset for foreignObject)
        const childIsSVG = isSVG && tag !== 'foreignObject';
        patchChildren(oldVNode, newVNode, element, childIsSVG);
    }

    function patchChildren(oldVNode: VNode, newVNode: VNode, container: HostElement, parentIsSVG: boolean = false, fallbackAnchor: HostNode | null = null) {
        const oldChildren = oldVNode.children;
        const newChildren = newVNode.children;

        newChildren.forEach((c: VNode) => c.parent = newVNode);

        reconcileChildrenArray(container, oldChildren, newChildren, parentIsSVG, fallbackAnchor);
    }

    function reconcileChildrenArray(parent: HostElement, oldChildren: VNode[], newChildren: VNode[], parentIsSVG: boolean = false, fallbackAnchor: HostNode | null = null) {
        // Check for duplicate keys in development
        if (process.env.NODE_ENV !== 'production') {
            checkDuplicateKeys(newChildren);
        }

        let oldStartIdx = 0;
        let oldEndIdx = oldChildren.length - 1;
        let oldStartVNode = oldChildren[0];
        let oldEndVNode = oldChildren[oldEndIdx];

        let newStartIdx = 0;
        let newEndIdx = newChildren.length - 1;
        let newStartVNode = newChildren[0];
        let newEndVNode = newChildren[newEndIdx];

        let oldKeyToIdx: Map<string | number, number> | undefined;

        while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
            if (oldStartVNode == null) {
                oldStartVNode = oldChildren[++oldStartIdx];
            } else if (oldEndVNode == null) {
                oldEndVNode = oldChildren[--oldEndIdx];
            } else if (isSameVNode(oldStartVNode, newStartVNode)) {
                patch(oldStartVNode, newStartVNode, parent);
                oldStartVNode = oldChildren[++oldStartIdx];
                newStartVNode = newChildren[++newStartIdx];
            } else if (isSameVNode(oldEndVNode, newEndVNode)) {
                patch(oldEndVNode, newEndVNode, parent);
                oldEndVNode = oldChildren[--oldEndIdx];
                newEndVNode = newChildren[--newEndIdx];
            } else if (isSameVNode(oldStartVNode, newEndVNode)) {
                patch(oldStartVNode, newEndVNode, parent);
                const nodeToMove = oldStartVNode.dom;
                const anchor = oldEndVNode.dom ? hostNextSibling(oldEndVNode.dom) : null;
                if (nodeToMove) {
                    hostInsert(nodeToMove, parent, anchor);
                }
                oldStartVNode = oldChildren[++oldStartIdx];
                newEndVNode = newChildren[--newEndIdx];
            } else if (isSameVNode(oldEndVNode, newStartVNode)) {
                patch(oldEndVNode, newStartVNode, parent);
                const nodeToMove = oldEndVNode.dom;
                const anchor = oldStartVNode.dom ?? null;
                if (nodeToMove) {
                    hostInsert(nodeToMove, parent, anchor);
                }
                oldEndVNode = oldChildren[--oldEndIdx];
                newStartVNode = newChildren[++newStartIdx];
            } else {
                if (!oldKeyToIdx) {
                    oldKeyToIdx = createKeyToKeyIndexMap(oldChildren, oldStartIdx, oldEndIdx);
                }
                const idxInOld = newStartVNode.key != null
                    ? oldKeyToIdx.get(String(newStartVNode.key))
                    : findIndexInOld(oldChildren, newStartVNode, oldStartIdx, oldEndIdx);

                if (idxInOld != null) {
                    const vnodeToMove = oldChildren[idxInOld];
                    patch(vnodeToMove, newStartVNode, parent);
                    oldChildren[idxInOld] = undefined!;
                    if (vnodeToMove.dom && oldStartVNode.dom) {
                        hostInsert(vnodeToMove.dom, parent, oldStartVNode.dom);
                    }
                } else {
                    mount(newStartVNode, parent, oldStartVNode.dom ?? null, parentIsSVG);
                }
                newStartVNode = newChildren[++newStartIdx];
            }
        }

        if (oldStartIdx > oldEndIdx) {
            if (newStartIdx <= newEndIdx) {
                const nextNewDom = newChildren[newEndIdx + 1]?.dom ?? null;
                // Fall back to the parent fragment's trailing anchor when no
                // following sibling VNode has a DOM yet — otherwise `null`
                // would mean "append to parent", which would push the new
                // nodes past any siblings that follow the fragment in the
                // parent DOM.
                const anchor = nextNewDom ?? fallbackAnchor ?? null;
                for (let i = newStartIdx; i <= newEndIdx; i++) {
                    mount(newChildren[i], parent, anchor, parentIsSVG);
                }
            }
        } else if (newStartIdx > newEndIdx) {
            for (let i = oldStartIdx; i <= oldEndIdx; i++) {
                if (oldChildren[i]) {
                    unmount(oldChildren[i], parent);
                }
            }
        }
    }

    // createPropsAccessor is now imported from component-helpers.ts

    function mountComponent(vnode: VNode, container: HostElement, before: HostNode | null, setup: SetupFn<any, any, any, any>) {
        // No wrapper element - we render directly into the container
        // Use an anchor comment to track the component's position
        const anchor = hostCreateComment('');
        vnode.dom = anchor; // The anchor serves as the component's "DOM" marker
        (anchor as unknown as InternalHostNode).__vnode = vnode;
        hostInsert(anchor, container, before);

        let exposed: any = null;
        let exposeCalled = false;

        const initialProps = vnode.props || {};
        // Create reactive props - exclude children, slots, and $models to avoid deep recursion on VNodes
        const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = initialProps;
        
        // Merge Model<T> objects directly into props for unified access: props.model.value
        const propsWithModels = { ...propsData };
        if (modelsData) {
            for (const modelKey in modelsData) {
                const modelValue = modelsData[modelKey];
                if (isModel(modelValue)) {
                    propsWithModels[modelKey] = modelValue;
                }
            }
        }
        
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

        const createdHooks: (() => void)[] = [];
        const mountHooks: ((ctx: MountContext) => void)[] = [];
        const updatedHooks: (() => void)[] = [];
        const unmountHooks: ((ctx: MountContext) => void)[] = [];

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
            onMounted: (fn: (ctx: MountContext) => void) => { mountHooks.push(fn); },
            onUnmounted: (fn: (ctx: MountContext) => void) => { unmountHooks.push(fn); },
            onCreated: (fn: () => void) => { createdHooks.push(fn); },
            onUpdated: (fn: () => void) => { updatedHooks.push(fn); },
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
            const setupResult = setup(ctx);
            // Async setup is only supported on server - check for promise
            if (setupResult && typeof (setupResult as any).then === 'function') {
                throw asyncSetupClientError(componentName ?? 'anonymous');
            }
            renderFn = setupResult as ViewFn;
            // Notify plugins that component was created (setup completed)
            notifyComponentCreated(currentAppContext, componentInstance);
            // Run component-level created hooks
            createdHooks.forEach(hook => hook());
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
        if (vnode.props?.ref) {
            const refValue = exposeCalled ? exposed : null;
            untrack(() => {
                if (typeof vnode.props.ref === 'function') {
                    vnode.props.ref(refValue);
                } else if (vnode.props.ref && typeof vnode.props.ref === 'object') {
                    vnode.props.ref.current = refValue;
                }
            });
        }

        if (renderFn) {
            ctx.renderFn = renderFn;

            // Shared mutable ref for the current subtree.
            // This ensures that when same-type patching replaces the VNode,
            // the effect closure and all aliased VNodes share the same subtree reference.
            const subTreeRef: { current: VNode | null } = { current: null };
            internalVNode._subTreeRef = subTreeRef;

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
                        patch(prevSubTree, subTree, container);
                        if (prevFocus && hostRestoreFocus && hostGetActiveElement!() !== prevFocus) {
                            hostRestoreFocus(prevFocus);
                        }
                        // Notify plugins of component update (re-render)
                        notifyComponentUpdated(currentAppContext, componentInstance);
                        // Run component-level updated hooks
                        updatedHooks.forEach(hook => hook());
                    } else {
                        mount(subTree, container, anchor);
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
            });
            internalVNode._effect = componentEffect;

            // Implement update() - re-runs the current render function
            // For HMR: set ctx.renderFn first, then call update()
            ctx.update = () => {
                componentEffect();
            };
        }

        // Run mount hooks (untrack to prevent signal reads from
        // polluting the parent component's reactive subscriptions)
        const mountCtx = { el: container } as MountContext;
        untrack(() => mountHooks.forEach(hook => hook(mountCtx)));

        // Notify plugins that component was mounted
        notifyComponentMounted(currentAppContext, componentInstance);

        // Store cleanup hooks on vnode for unmount
        vnode.cleanup = () => {
            // Notify plugins that component is being unmounted
            notifyComponentUnmounted(currentAppContext, componentInstance);
            unmountHooks.forEach(hook => hook(mountCtx as MountContext));
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
