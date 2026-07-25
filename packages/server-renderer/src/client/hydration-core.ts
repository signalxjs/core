/**
 * The hydration executor — the LAZY half of selective hydration
 * (rfc-ssr-platform §1.2). Everything here transitively needs the renderer
 * (`render`, `hydrateComponent`), so the scheduler (`./scheduler`) loads
 * this module via a dynamic import on the first strategy that fires; a page
 * whose strategies never fire never executes any of it.
 *
 * The dependency arrow points one way: this module imports scheduler
 * helpers, never the reverse (the scheduler only reaches this module through
 * `loadHydrationCore()`'s `import()`).
 */

import { VNode, render } from 'sigx';
import { seedErrorScopeError } from 'sigx/internals';
import type { SSRBoundaryRecord, BoundaryHydrate } from '../boundary';
import { hydrateComponent } from './hydrate-component';
import { getCurrentAppContext, setCurrentAppContext } from './plugin-registry';
import { loadBoundaryComponent } from './chunk-loader';
import { registerComponent, type ComponentFactory } from './registry';
import { seedBoundaryState } from './boundary-state';
// Decode server-sent boundary payloads here, in the LAZY chunk — never in the
// eager scheduler, whose size guard forbids pulling a runtime (docs/seams.md).
import { reviveFromServer } from 'sigx/internals';
import {
    getBoundaryTable,
    getBoundaryRecord,
    findComponentBoundaries,
    findBoundaryMarker,
    invalidateMarkerIndex,
    parseMarkerId,
    isSkipPlaceholder,
    firstElementBetween,
    scheduleByStrategy
} from './scheduler';

// ============= The pending-boundary bridge =============

/**
 * What the root walk knows about a streamed boundary it skipped, handed to
 * the `sigx:async-ready` flow so the replacement hydrates the LIVE vnode
 * from the parent's tree instead of an orphan copy (#478).
 *
 * Without it the walk-skipped vnode stays a ghost forever — no `dom`, no
 * `_effect`, no `_subTree` — and the next patch from its parent either mounts
 * a duplicate or dereferences a null anchor.
 */
interface PendingBoundary {
    /** The live vnode the walk was about to hydrate. */
    vnode: VNode;
    /** Its real DOM parent (the placeholder's parent, not the placeholder). */
    parent: Node;
    /** The component's trailing `<!--$c:N-->` marker — OUTSIDE the wrapper. */
    marker: Comment | null;
}

/**
 * The bridge rides an expando on the placeholder element rather than a
 * module-level map: the reference then lives exactly as long as the
 * placeholder does, so nothing needs clearing on SPA navigation and no entry
 * can go stale. Same discipline as the renderer's `element.__vnode` and
 * `hydrate()`'s `container._vnode`.
 */
type PendingCarrier = { __sigxPendingBoundary?: PendingBoundary };

// ============= Mount/hydrate primitives =============

/** Build the mount vnode for a data-driven boundary (props from the table). */
function recordVNode(component: ComponentFactory, record: SSRBoundaryRecord): VNode {
    return {
        type: component as any,
        props: (reviveFromServer(record.props) as Record<string, unknown>) || {},
        key: null,
        children: [],
        dom: null
    } as VNode;
}

/**
 * Hydrate a boundary in place: the element before its trailing marker is the
 * SSR content root. Stages the record's state snapshot (#120) for the pack's
 * client transformComponentContext hook.
 */
export function hydrateBoundaryInPlace(marker: Comment, component: ComponentFactory, record: SSRBoundaryRecord): void {
    let container: Node | null = marker.previousSibling;
    while (container && container.nodeType !== Node.ELEMENT_NODE) {
        container = container.previousSibling;
    }

    if (!container || container.nodeType !== Node.ELEMENT_NODE) {
        if (__DEV__) {
            console.warn('No element found for boundary hydration');
        }
        return;
    }

    seedBoundaryState(reviveFromServer(record.state) as Record<string, any>);
    if (record.errorScope) {
        seedErrorScopeError(new Error(record.errorScope.message));
    }
    const vnode = recordVNode(component, record);
    const parent = container.parentNode!;
    try {
        hydrateComponent(vnode, container, parent, marker);
    } finally {
        // Clear even on throw so stale state can't seed the next hydration.
        seedBoundaryState(null);
        seedErrorScopeError(null);
    }
}

/**
 * Fresh-mount a skip boundary (flush: 'skip' — islands client:only) into its
 * placeholder. Falls back to in-place hydration when the previous element is
 * not genuinely our placeholder (content SSR'd in place or unrelated markup).
 */
export function mountSkipBoundary(marker: Comment, component: ComponentFactory, record: SSRBoundaryRecord): void {
    let placeholder = marker.previousSibling;
    while (placeholder && placeholder.nodeType !== Node.ELEMENT_NODE) {
        placeholder = placeholder.previousSibling;
    }

    const wantId = parseMarkerId(marker);
    if (!isSkipPlaceholder(placeholder as Element | null, wantId)) {
        hydrateBoundaryInPlace(marker, component, record);
        return;
    }

    const container = placeholder as Element;
    container.innerHTML = '';
    render(recordVNode(component, record), container);
}

// ============= Walk-driven scheduling (auto mode) =============

/**
 * Schedule a boundary encountered during the root hydration walk. Receives
 * the LIVE vnode (children/slots intact) so in-place hydration matches what
 * an immediate walk would have produced. Returns the next DOM node after
 * this component's content.
 *
 * Lives on the executor side of the scheduler/core split: it closes over
 * the live vnode and `hydrateComponent`, and is only reachable from the
 * root walk — which is already heavy by definition.
 *
 * `regionEnd` is the walk's region bound (the enclosing component's trailing
 * marker); it keeps this boundary's marker pick exact when its content is
 * followed by sibling content in the same parent (#373).
 */
export function scheduleWalkedBoundary(
    vnode: VNode,
    dom: Node | null,
    parent: Node,
    record: SSRBoundaryRecord,
    regionEnd: Node | null = null
): Node | null {
    const { contentStart, trailingMarker } = findComponentBoundaries(dom, regionEnd);

    const componentFactory = vnode.type as unknown as ComponentFactory;
    const componentName = componentFactory.__islandId || componentFactory.__name || 'Anonymous';

    // Skip async placeholders during the walk — the sigx:async-ready flow
    // hydrates them when their content streams in.
    if (contentStart && (contentStart as Element).hasAttribute?.('data-async-placeholder')) {
        if (componentName !== 'Anonymous') {
            registerComponent(componentName, componentFactory);
        }
        // Hand this position to that flow: the LIVE vnode, its real parent and
        // the trailing marker the server emitted outside the wrapper. Hydrating
        // the live vnode is what keeps the parent's tree patchable afterwards
        // (#478). `vnode.dom` stays null until then — pointing it at the marker
        // would make a parent patch during the streaming window treat a comment
        // node as this component's element, since `_effect` does not exist yet.
        (contentStart as unknown as PendingCarrier).__sigxPendingBoundary = {
            vnode,
            parent,
            marker: trailingMarker
        };
        return trailingMarker ? trailingMarker.nextSibling : dom;
    }

    const capturedAppContext = getCurrentAppContext();
    const componentId = trailingMarker ? parseMarkerId(trailingMarker) : null;
    const strategy: BoundaryHydrate = record.hydrate ?? 'load';

    const doHydrate = () => {
        const prevAppContext = getCurrentAppContext();
        setCurrentAppContext(capturedAppContext);
        // Stage the freshest state snapshot for the pack's restore hook.
        const fresh = (componentId !== null ? getBoundaryRecord(componentId) : undefined) ?? record;
        seedBoundaryState(reviveFromServer(fresh.state) as Record<string, any>);
        // A server-caught errorScope failure: seed the client scope errored
        // so the fallback hydrates against the server's fallback HTML and
        // retry() performs the remount (rfc-ssr-platform §2.2).
        if (fresh.errorScope) {
            seedErrorScopeError(new Error(fresh.errorScope.message));
        }
        try {
            hydrateComponent(vnode, contentStart, parent, trailingMarker);
        } finally {
            setCurrentAppContext(prevAppContext);
            // Defensively clear: stale state must not leak into the next hydration.
            seedBoundaryState(null);
            seedErrorScopeError(null);
        }
    };

    if (record.flush === 'skip') {
        // Skip-SSR: the server emitted an empty <div data-boundary> placeholder.
        // Mount fresh into it; fall back to in-place hydration when there is no
        // placeholder (content SSR'd in place). Bound the search by
        // trailingMarker so we never drift into a sibling's DOM.
        const wantId = trailingMarker ? parseMarkerId(trailingMarker) : null;
        let ph: Node | null = contentStart;
        while (ph && ph !== trailingMarker && ph.nodeType !== Node.ELEMENT_NODE) ph = ph.nextSibling;
        if (ph && ph !== trailingMarker && isSkipPlaceholder(ph as Element, wantId)) {
            const container = ph as Element;
            container.innerHTML = '';
            const prevAppContext = getCurrentAppContext();
            setCurrentAppContext(capturedAppContext);
            try {
                render(vnode, container);
            } finally {
                setCurrentAppContext(prevAppContext);
            }
        } else {
            doHydrate();
        }
        return trailingMarker ? trailingMarker.nextSibling : dom;
    }

    const anchor = firstElementBetween(contentStart, trailingMarker);
    // The walk-driven visible strategy keeps islands' pre-load margin.
    scheduleByStrategy(strategy, record.media, anchor, doHydrate, '50px');

    return trailingMarker ? trailingMarker.nextSibling : dom;
}

// ============= Streamed-boundary hydration (sigx:async-ready) =============

function reportAsyncHydrateError(err: unknown): void {
    if (__DEV__) {
        console.error('[Hydrate] Failed to hydrate streamed async boundary:', err);
    }
}

/**
 * Hydrate a boundary whose content just streamed in via $SIGX_REPLACE.
 */
export async function hydrateAsyncBoundary(container: Element, record: SSRBoundaryRecord): Promise<void> {
    // The root walk hands over the live vnode for a placeholder it skipped
    // (#478); only the record-driven path — `boundaries: 'explicit'`, where no
    // walk ever ran — has to rebuild one from the table.
    //
    // TAKEN FIRST, ahead of every early return below, and never merely read:
    // the wrapper is deliberately left in the DOM after an unmount, so an
    // entry nobody consumes keeps the skipped vnode (and everything it
    // references) reachable for as long as that empty div sits in the
    // document. `hydrate: 'never'` never consumes one at all, and a replace
    // that lands mid-walk marks the placeholder hydrated before the walk gets
    // there. Discarding is right in both: once the guards below return, this
    // placeholder is done, either hydrated already or static by contract.
    const carrier = container as unknown as PendingCarrier;
    const pending = carrier.__sigxPendingBoundary;
    delete carrier.__sigxPendingBoundary;

    // The hydrate axis holds for streamed content too: a boundary
    // explicitly marked 'never' stays static HTML.
    if (record.hydrate === 'never') {
        return;
    }

    if (container.hasAttribute('data-hydrated')) {
        return;
    }

    if (!pending && !record.component) {
        if (__DEV__) {
            console.error(`[Hydrate] No component name in boundary record`);
        }
        return;
    }

    // Mark synchronously, BEFORE any await, so duplicate triggers (the
    // leftover scan racing the sigx:async-ready event, or repeated events for
    // one id) can't both pass the guard above and double-mount the component.
    // The scheduler's listener reaches this via `loadHydrationCore().then`,
    // so concurrent triggers still enter here sequentially (microtasks on
    // one resolved promise) and the guard holds.
    container.setAttribute('data-hydrated', '');

    let vnode: VNode;
    if (pending) {
        vnode = pending.vnode;
    } else {
        const component = await loadBoundaryComponent(record);
        if (!component) {
            if (__DEV__) {
                console.error(`[Hydrate] Component "${record.component}" could not be resolved`);
            }
            return;
        }
        vnode = recordVNode(component, record);
    }

    // Anchor the component on its real trailing marker, which the server
    // emitted OUTSIDE the wrapper (it closes the div first). Handing
    // `hydrateComponent` the placeholder itself is what makes it treat the
    // wrapper as a wrapper (content = its children) — the walk-driven path's
    // shape. Passing the wrapper's firstChild instead left `vnode.dom` null,
    // and the next patch touching the component crashed on it (#478).
    // (Ids start at 1, so a NaN/0 attribute falls out as falsy.)
    const id = Number(container.getAttribute('data-async-placeholder'));
    const marker = pending?.marker ?? (id ? findBoundaryMarker(id) : null);
    const parent = pending?.parent ?? container.parentNode;

    // Seed restored boundary signal state BEFORE hydrating.
    seedBoundaryState(reviveFromServer(record.state) as Record<string, any>);
    try {
        if (marker && parent) {
            hydrateComponent(vnode, container, parent, marker);
        } else {
            // No reachable marker (or a detached placeholder): hydrate the
            // wrapper's children in place, as before.
            hydrateComponent(vnode, container.firstChild, container);
        }
    } finally {
        // Clear even on throw so stale state can't seed the next hydration.
        seedBoundaryState(null);
    }
}

/**
 * Check for async boundaries that were skipped during the hydration walk but
 * whose $SIGX_REPLACE script already ran (event fired before the listener
 * was ready). Core runs this after hydrate() when a table exists.
 */
export function hydrateLeftoverBoundaries(container: Element): void {
    const placeholders = container.querySelectorAll('[data-async-placeholder]:not([data-hydrated])');
    if (placeholders.length === 0) return;
    // Every replace already applied mutated the DOM; the marker index each
    // boundary's anchor lookup uses must not predate them. (The
    // sigx:async-ready listener invalidates per event — this path has no event.)
    invalidateMarkerIndex();

    const table = getBoundaryTable();
    for (const placeholder of placeholders) {
        const id = placeholder.getAttribute('data-async-placeholder');
        if (!id) continue;

        const record = table[id];
        // Hydrate every streamed-in async boundary, not only those that
        // captured signal state — an async component with no tracked state
        // must still become interactive.
        if (record) {
            void hydrateAsyncBoundary(placeholder as Element, record).catch(reportAsyncHydrateError);
        }
    }
}
