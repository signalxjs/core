/**
 * Component hydration logic — strategy-agnostic
 *
 * Handles running component setup, creating reactive effects,
 * and restoring server state for hydrated components.
 * Does not depend on islands or any specific SSR strategy.
 */

import {
    VNode,
    getCurrentInstance,
    signal,
    effect,
    isModel
} from 'sigx';
import type { ComponentSetupContext, SlotsObject } from 'sigx';
import {
    setCurrentInstance,
    createPropsAccessor,
    createSlots,
    normalizeSubTree,
    patch,
    mount,
    patchProp,
    filterClientDirectives,
    createEmit,
    provideAppContext,
} from 'sigx/internals';
import {
    InternalVNode,
    createRestoringSignal,
    getCurrentAppContext
} from './hydrate-context';
import { hydrateNode } from './hydrate-core';

/**
 * Minimal type for component factories used in hydration.
 * Compatible with ComponentFactory from runtime-core.
 */
export interface ComponentFactory {
    __setup: Function;
    __name?: string;
    __async?: boolean;
}

/**
 * Hydrate a component - run setup and create reactive effect
 *
 * With trailing markers, the structure is: <content><!--$c:id-->
 * - dom points to start of content
 * - trailingMarker (if provided) is the anchor at the end
 *
 * @param vnode - The VNode to hydrate
 * @param dom - The DOM node to start from (content starts here)
 * @param parent - The parent node
 * @param serverState - Optional state captured from server for async components
 * @param trailingMarker - Optional trailing marker comment (the component anchor)
 */
export function hydrateComponent(vnode: VNode, dom: Node | null, parent: Node, serverState?: Record<string, any>, trailingMarker?: Comment | null): Node | null {
    const componentFactory = vnode.type as unknown as ComponentFactory;
    const setup = componentFactory.__setup;
    const componentName = componentFactory.__name || 'Anonymous';

    // With trailing markers, find the marker if not provided
    let anchor: Comment | null = trailingMarker || null;
    let componentId: number | null = null;

    if (!anchor) {
        // Find this component's trailing marker by traversing forward.
        // SSR emits <!--$c:N--> after each component's content, with parent IDs
        // lower than child IDs. When nested components exist, child markers appear
        // before the parent marker. We find the correct (outermost) marker by
        // looking for the lowest-ID $c: comment in a contiguous sequence.
        let current: Node | null = dom;
        let bestAnchor: Comment | null = null;
        let bestId: number = Infinity;
        let foundAnyMarker = false;

        while (current) {
            if (current.nodeType === Node.COMMENT_NODE) {
                const text = (current as Comment).data;
                if (text.startsWith('$c:')) {
                    const id = parseInt(text.slice(3), 10);
                    if (id < bestId) {
                        bestId = id;
                        bestAnchor = current as Comment;
                    }
                    foundAnyMarker = true;
                }
            } else if (foundAnyMarker) {
                // Hit a non-comment node after finding markers — we've passed
                // our component's boundary and entered a sibling's content
                break;
            }
            current = current.nextSibling;
        }

        if (bestAnchor) {
            anchor = bestAnchor;
            componentId = bestId;
        }
    } else {
        // Extract component ID from provided marker
        const text = anchor.data;
        if (text.startsWith('$c:')) {
            componentId = parseInt(text.slice(3), 10);
        }
    }

    const internalVNode = vnode as InternalVNode;
    const initialProps = vnode.props || {};
    const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = filterClientDirectives(initialProps);

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

    // Create reactive props
    const reactiveProps = signal(propsWithModels);
    internalVNode._componentProps = reactiveProps;

    // Create slots
    const slots = createSlots(children, slotsFromProps);
    internalVNode._slots = slots;

    const mountHooks: ((ctx: any) => void)[] = [];
    const unmountHooks: ((ctx: any) => void)[] = [];
    const createdHooks: (() => void)[] = [];
    const updatedHooks: (() => void)[] = [];

    const parentInstance = getCurrentInstance();

    // Use restoring signal when we have server state to restore
    const signalFn = serverState
        ? createRestoringSignal(serverState)
        : signal;

    // Create SSR helper for client-side
    // When hydrating with server state, ssr.load() is a no-op (data already restored)
    const hasServerState = !!serverState;
    const ssrHelper = {
        load(_fn: () => Promise<void>): void {
            // No-op on client when hydrating - signal state was restored from server
        },
        isServer: false,
        isHydrating: hasServerState
    };

    const componentCtx: ComponentSetupContext = {
        el: parent as HTMLElement,
        signal: signalFn as typeof signal,
        props: createPropsAccessor(reactiveProps),
        slots: slots,
        emit: createEmit(reactiveProps),
        parent: parentInstance,
        onMounted: (fn) => { mountHooks.push(fn); },
        onUnmounted: (fn) => { unmountHooks.push(fn); },
        onCreated: (fn) => { createdHooks.push(fn); },
        onUpdated: (fn) => { updatedHooks.push(fn); },
        expose: () => { },
        renderFn: null,
        update: () => { },
        ssr: ssrHelper,
        _serverState: serverState
    };

    // For ROOT component only (no parent), provide the AppContext
    if (!parentInstance && getCurrentAppContext()) {
        provideAppContext(componentCtx, getCurrentAppContext()!);
    }

    const prev = setCurrentInstance(componentCtx);
    let renderFn: (() => any) | undefined;

    try {
        renderFn = setup(componentCtx);
    } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Error hydrating component ${componentName}:`, err);
        }
    } finally {
        setCurrentInstance(prev);
    }

    // Track where the component's DOM starts
    let endDom: Node | null = dom;

    if (renderFn) {
        componentCtx.renderFn = renderFn;
        let isFirstRender = true;

        // Shared mutable ref for the current subtree (same pattern as renderer).
        // This ensures that when same-type patching replaces the VNode,
        // the effect closure and all aliased VNodes share the same subtree reference.
        const subTreeRef: { current: VNode | null } = { current: null };
        internalVNode._subTreeRef = subTreeRef;

        // Create reactive effect - on first run, hydrate; on subsequent, use render()
        const componentEffect = effect(() => {
            const prevInstance = setCurrentInstance(componentCtx);
            try {
                const subTreeResult = componentCtx.renderFn!();
                const prevSubTree = subTreeRef.current;

                // Handle null/undefined renders (e.g., conditional components like Modal)
                if (subTreeResult == null) {
                    if (isFirstRender) {
                        // Check if there's SSR content in the DOM (between dom and anchor).
                        // This happens when a lazy() component returns null on first render
                        // (chunk not loaded yet) but the server rendered the full content.
                        // In that case, keep isFirstRender=true so the next render (after the
                        // lazy component resolves) will hydrate against the existing SSR DOM
                        // instead of mounting a duplicate.
                        const hasSSRContent = dom != null && anchor != null && dom !== anchor;
                        if (!hasSSRContent) {
                            // Truly null first render — SSR also rendered nothing
                            isFirstRender = false;
                        }
                        // If hasSSRContent, leave isFirstRender=true and SSR DOM visible.
                        // The component will hydrate when it re-renders with real content.
                    } else if (prevSubTree && prevSubTree.dom) {
                        // Had content before, now returning null - unmount the previous subtree
                        const patchContainer = prevSubTree.dom.parentNode as Element || parent;
                        const emptyNode = normalizeSubTree(null);
                        patch(prevSubTree, emptyNode, patchContainer);
                        subTreeRef.current = emptyNode;
                        internalVNode._subTree = emptyNode;
                    }
                    return;
                }

                const subTree = normalizeSubTree(subTreeResult);

                if (isFirstRender) {
                    isFirstRender = false;

                    // Check if SSR actually produced content for this component.
                    // When dom is null or points directly at the anchor comment,
                    // SSR rendered nothing (e.g., lazy() returned null on the server).
                    // In that case, mount fresh instead of trying to hydrate
                    // against non-existent DOM.
                    const hasSSRContent = dom != null && dom !== anchor;
                    if (hasSSRContent) {
                        // Hydrate against existing SSR DOM
                        endDom = hydrateNode(subTree, dom, parent);
                    } else {
                        // No SSR content — mount fresh before the anchor
                        mount(subTree, parent as Element, anchor || null);
                    }
                    subTreeRef.current = subTree;
                    internalVNode._subTree = subTree;
                } else {
                    // Subsequent renders - use patch directly like runtime-core does
                    if (prevSubTree) {
                        const patchContainer = prevSubTree.dom?.parentNode as Element || parent;
                        patch(prevSubTree, subTree, patchContainer);
                    } else {
                        // No previous subtree - mount fresh using the component's anchor
                        mount(subTree, parent as Element, anchor || null);
                    }
                    subTreeRef.current = subTree;
                    internalVNode._subTree = subTree;
                }
            } finally {
                setCurrentInstance(prevInstance);
            }
        });

        internalVNode._effect = componentEffect;
        componentCtx.update = () => componentEffect();
    }

    // Use trailing anchor comment as the component's dom reference
    vnode.dom = anchor || endDom;

    // Run mount hooks
    const mountCtx = { el: parent as Element };
    createdHooks.forEach(hook => hook());
    mountHooks.forEach(hook => hook(mountCtx));

    // Store cleanup
    vnode.cleanup = () => {
        unmountHooks.forEach(hook => hook(mountCtx));
    };

    // With trailing markers, the anchor IS the end - return next sibling
    return anchor ? anchor.nextSibling : endDom;
}
