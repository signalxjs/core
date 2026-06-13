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
    untrack
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
    createEmit,
    splitComponentProps,
    provideAppContext,
    queueJob,
    nextJobId,
} from 'sigx/internals';
import type { SchedulerJob } from 'sigx/internals';
import {
    InternalVNode,
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
 * @param trailingMarker - Optional trailing marker comment (the component anchor)
 */
export function hydrateComponent(vnode: VNode, dom: Node | null, parent: Node, trailingMarker?: Comment | null): Node | null {
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
    // Strategy packs (e.g. islands) strip their own marker props before
    // delegating here — core has no knowledge of any directive prefix.
    const { children, slotsFromProps, propsWithModels } = splitComponentProps(initialProps);

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

    // Environment flags: hydrating server-rendered DOM. Data loading lives
    // in useAsync/useStream — restored values come from window.__SIGX_ASYNC__.
    const ssrHelper = {
        isServer: false,
        isHydrating: true
    };

    const componentCtx: ComponentSetupContext = {
        el: parent as HTMLElement,
        signal: signal,
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
        ssr: ssrHelper
    };

    // For ROOT component only (no parent), provide the AppContext
    if (!parentInstance && getCurrentAppContext()) {
        provideAppContext(componentCtx, getCurrentAppContext()!);
    }

    const prev = setCurrentInstance(componentCtx);
    let renderFn: (() => any) | undefined;

    try {
        // Untracked for the same reason as runtime-core's mountComponent
        // (#111): hydration mounts descendants inside an ancestor's render
        // effect — setup reads must not become ancestor dependencies.
        renderFn = untrack(() => setup(componentCtx));
    } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Error hydrating component ${componentName}:`, err);
        }
    } finally {
        setCurrentInstance(prev);
    }

    // Streamed async components (and Suspense boundaries) render inside a
    // <div data-async-placeholder> wrapper that is NOT part of the vnode
    // tree. Hydrate against the wrapper's children — matching the wrapper
    // itself against the component's first element would mismatch and mount
    // a duplicate copy of the content.
    let hydrateDom: Node | null = dom;
    let hydrateParent: Node = parent;
    if (
        dom &&
        dom.nodeType === Node.ELEMENT_NODE &&
        (dom as Element).hasAttribute('data-async-placeholder')
    ) {
        hydrateParent = dom;
        hydrateDom = dom.firstChild;
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

        // Route re-renders through the shared render queue (same policy
        // as runtime-core's mountComponent): deduped per component,
        // parents flush before children. First render stays inline.
        let scheduledRun: (() => void) | undefined;
        const renderJob: SchedulerJob = Object.assign(
            () => { if (scheduledRun) scheduledRun(); },
            { id: nextJobId() }
        );

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
                        const hasSSRContent = hydrateDom != null && anchor != null && hydrateDom !== anchor;
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
                    const hasSSRContent = hydrateDom != null && hydrateDom !== anchor;
                    if (hasSSRContent) {
                        // Hydrate against existing SSR DOM (inside the
                        // placeholder wrapper when one exists)
                        endDom = hydrateNode(subTree, hydrateDom, hydrateParent);
                    } else if (hydrateParent !== parent) {
                        // Empty placeholder wrapper — mount inside it
                        mount(subTree, hydrateParent as Element, null);
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
                    } else if (hydrateParent !== parent) {
                        // No previous subtree — mount inside the placeholder wrapper
                        mount(subTree, hydrateParent as Element, null);
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
        }, {
            scheduler: (run) => {
                scheduledRun = run;
                queueJob(renderJob);
            },
        });

        internalVNode._effect = componentEffect;
        componentCtx.update = () => componentEffect();
    }

    // Use trailing anchor comment as the component's dom reference
    vnode.dom = anchor || endDom;

    // Run created + mount hooks — untracked, mirroring runtime-core's
    // mount path (#111): during hydration these run inside an ancestor's
    // render effect, so reactive reads in a hook must not become
    // ancestor dependencies.
    const mountCtx = { el: parent as Element };
    untrack(() => {
        createdHooks.forEach(hook => hook());
        mountHooks.forEach(hook => hook(mountCtx));
    });

    // Store cleanup
    vnode.cleanup = () => {
        unmountHooks.forEach(hook => hook(mountCtx));
    };

    // With trailing markers, the anchor IS the end - return next sibling
    return anchor ? anchor.nextSibling : endDom;
}
