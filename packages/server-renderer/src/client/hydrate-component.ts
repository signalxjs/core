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
import type { ComponentSetupContext } from 'sigx';
import {
    setCurrentInstance,
    createPropsAccessor,
    createSlots,
    normalizeSubTree,
    patch,
    mount,
    createEmit,
    splitComponentProps,
    provideAppContext,
    queueJob,
    nextJobId,
    applyErrorScope,
    collectSetupScope,
    takeSetupDisposers,
} from 'sigx/internals';
import type { SchedulerJob } from 'sigx/internals';
import {
    InternalVNode,
    getCurrentAppContext,
    getClientPlugins
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

    let componentCtx: ComponentSetupContext = {
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

    // Let plugins transform the context before setup runs (mirror of the
    // server's transformComponentContext). A strategy pack can swap ctx.signal
    // for a state-restoring variant here — core stays strategy-agnostic.
    for (const plugin of getClientPlugins()) {
        const next = plugin.client?.transformComponentContext?.(vnode, componentCtx);
        if (next) componentCtx = next;
    }

    // For ROOT component only (no parent), provide the AppContext. Run this AFTER
    // the transform hooks so a plugin that returns a replacement context still
    // receives the AppContext (the hook contract allows swapping the whole ctx).
    if (!parentInstance && getCurrentAppContext()) {
        provideAppContext(componentCtx, getCurrentAppContext()!);
    }

    const prev = setCurrentInstance(componentCtx);
    let renderFn: (() => any) | undefined;
    // Disposers for effect()/watch() the setup creates directly, run on
    // unmount (#288). Null until setup creates one — reaction-less setups
    // allocate nothing.
    let setupDisposers: (() => void)[] | null = null;

    try {
        // Untracked for the same reason as runtime-core's mountComponent
        // (#111): hydration mounts descendants inside an ancestor's render
        // effect — setup reads must not become ancestor dependencies.
        // collectSetupScope ties the setup's reactions to unmount (#288).
        renderFn = collectSetupScope(() => untrack(() => setup(componentCtx)));
        setupDisposers = takeSetupDisposers();
        // errorScope: render through the scope wrapper (fallback while
        // errored, generation-keyed subtree otherwise) — the same wrapping
        // runtime-core's mountComponent applies. A hydrator-seeded server
        // error makes the first render the fallback, matching the server's
        // fallback HTML, with a live retry.
        if (renderFn) {
            renderFn = applyErrorScope(componentCtx, renderFn);
        }
    } catch (err) {
        // If setup threw mid-collection, takeSetupDisposers() above was
        // skipped — dispose the partial reactions and clear reactivity's
        // pending slot so it can't leak into the next hydration/mount (#288).
        const partial = takeSetupDisposers();
        if (partial) {
            for (let i = 0, len = partial.length; i < len; i++) partial[i]();
        }
        if (__DEV__) {
            console.error(`Error hydrating component ${componentName}:`, err);
        }
    } finally {
        setCurrentInstance(prev);
    }

    // Streamed async components (and Defer boundaries) render inside a
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
                    // The component's SSR content is bounded by its trailing
                    // marker (anchor) when its content lives directly in the
                    // parent. Inside an async-placeholder wrapper the content is
                    // the wrapper's children (bounded by the end of the wrapper,
                    // i.e. null) and the marker lives outside the wrapper.
                    const inWrapper = hydrateParent !== parent;
                    const rangeEnd: Node | null = inWrapper ? null : anchor;
                    // The mismatch cleanup is only safe when the removable SSR
                    // range is bounded: inside a wrapper (its children ARE the
                    // range) or when the trailing marker exists (it terminates
                    // the range within the shared parent). Without a marker and
                    // outside a wrapper, rangeEnd is null and removing
                    // [hydrateDom, null) would wipe following siblings owned by
                    // other components — so fall through to in-place hydration.
                    const rangeIsBounded = inWrapper || anchor != null;
                    if (hasSSRContent && rangeIsBounded && !subtreeMatchesSSRDom(subTree, hydrateDom, rangeEnd)) {
                        // Structural mismatch at the top of this component's
                        // subtree (e.g. SSR rendered an empty-state, the client
                        // renders a populated list — common with client/server
                        // data differences and lazy() components that hydrate
                        // late). Hydrating in place would abandon the SSR nodes
                        // as visible orphans (#115). Bail to a clean client
                        // render: discard the component's SSR DOM range
                        // [hydrateDom, rangeEnd) and mount the subtree fresh in
                        // its place. The range is bounded by the component's
                        // trailing marker (or wrapper), so this removes exactly
                        // this component's content and nothing a sibling owns.
                        if (__DEV__) {
                            console.warn(
                                `[Hydrate] Structural mismatch hydrating <${componentName}>; ` +
                                'discarding server-rendered subtree and re-rendering on the client. ' +
                                'SSR output did not match the client render for this component.'
                            );
                        }
                        removeSSRRange(hydrateDom, rangeEnd, hydrateParent);
                        mount(subTree, hydrateParent as Element, rangeEnd);
                        endDom = rangeEnd;
                    } else if (hasSSRContent) {
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
        // Dispose setup effect()/watch() AFTER onUnmounted hooks (#288).
        if (setupDisposers) {
            const disposers = setupDisposers;
            setupDisposers = null;
            for (let i = 0, len = disposers.length; i < len; i++) disposers[i]();
        }
    };

    // With trailing markers, the anchor IS the end - return next sibling
    return anchor ? anchor.nextSibling : endDom;
}

/**
 * Decide whether a component's render subtree structurally matches the SSR DOM
 * it would hydrate against (#115).
 *
 * Returns false only when we can prove a top-of-subtree structural mismatch:
 * the subtree's leading element has a tag that differs from the first element
 * node SSR produced for this component. In that case the caller bails to a
 * fresh client mount for the whole subtree (React/Vue "bail to client render"
 * semantics) instead of hydrating in place and leaving orphaned SSR nodes.
 *
 * Conservative by design: returns true (hydrate normally) for anything it
 * does not classify as an element-root mismatch — Text/Comment/Fragment and
 * component roots, and cases where SSR produced no element to compare against.
 * This is a scoping decision, not a safety guarantee for those shapes: a
 * Text/Comment subtree whose SSR DOM was an element (or vice versa) can still
 * leave orphans, since hydrateNode's Text/Comment mismatch paths insert a
 * fresh node without removing the mismatched SSR node and the component
 * boundary means it is never revisited. Those residual cases are out of scope
 * for this targeted fix (see the CHANGELOG note for #115); only the
 * element-root tag mismatch — the reported empty-state-vs-list symptom — is
 * cleaned up here.
 *
 * @param subTree     The normalized render result.
 * @param startDom    First SSR node of the component's content.
 * @param anchor      The component's trailing marker (exclusive range end), or null.
 */
function subtreeMatchesSSRDom(subTree: VNode, startDom: Node | null, anchor: Node | null): boolean {
    // Only element-rooted subtrees are classified here. A leading element with
    // the wrong tag is the unambiguous, anchor-bounded mismatch case.
    if (typeof subTree.type !== 'string') {
        return true;
    }

    // Find the first element node in the SSR range [startDom, anchor), skipping
    // comment artifacts (e.g. <!--t--> separators, nested $c: markers).
    let node: Node | null = startDom;
    while (node && node !== anchor) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            return (node as Element).tagName.toLowerCase() === subTree.type.toLowerCase();
        }
        if (node.nodeType === Node.TEXT_NODE) {
            // SSR produced leading text where the client wants an element.
            // hydrateNode's element branch would scan past this text looking
            // for a matching element and abandon it — treat as a mismatch so
            // the range is cleaned up and remounted.
            return false;
        }
        node = node.nextSibling;
    }

    // No element found in the range to compare against — let normal hydration
    // (and its existing empty/null handling) deal with it.
    return true;
}

/**
 * Remove the SSR DOM nodes spanning a component's abandoned subtree —
 * everything in [startDom, anchor) — so a fresh client mount leaves no
 * orphaned/duplicate content (#115). The anchor itself is preserved as the
 * mount insertion point.
 */
function removeSSRRange(startDom: Node | null, anchor: Node | null, parent: Node): void {
    let node: Node | null = startDom;
    while (node && node !== anchor) {
        const next: Node | null = node.nextSibling;
        if (node.parentNode === parent) {
            parent.removeChild(node);
        }
        node = next;
    }
}
