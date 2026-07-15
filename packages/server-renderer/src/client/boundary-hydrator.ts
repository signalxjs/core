/**
 * The boundary hydrator (rfc-ssr-platform §1.2) — selective hydration as THE
 * hydrator. Reads the per-request `window.__SIGX_BOUNDARIES__` table and
 * schedules each boundary per its hydrate strategy:
 *
 * - load        — immediately
 * - idle        — requestIdleCallback (setTimeout fallback)
 * - visible     — IntersectionObserver
 * - media       — matchMedia
 * - interaction — first pointerdown/keydown/touchstart/focusin (once; no
 *                 event replay — replay is resumability territory, gated
 *                 behind `beforeHydrate → false`)
 * - never       — not scheduled at all
 *
 * `flush: 'skip'` records (islands `client:only`) fresh-mount into the
 * core-emitted `<div data-boundary>` placeholder instead of hydrating.
 *
 * Two driving modes converge here:
 * - data-driven (`scheduleTableBoundaries`) — no root walk; every table
 *   entry schedules itself (the `boundaries: 'explicit'` app default);
 * - walk-driven (`scheduleWalkedBoundary`) — the root walk intercepts
 *   components that have a table record and defers them per strategy.
 *
 * Generalized from the islands pack's scheduler; the islands package
 * re-exports this machinery and stays a mapping from `client:*` directives
 * to boundary records.
 */

import { VNode, render } from 'sigx';
import { seedErrorScopeError } from 'sigx/internals';
import type { SSRBoundaryRecord, BoundaryHydrate } from '../boundary';
import { hydrateComponent } from './hydrate-component';
import { getCurrentAppContext, setCurrentAppContext } from './hydrate-context';
import { loadBoundaryComponent } from './chunk-loader';
import { registerComponent, type ComponentFactory } from './registry';
import { seedBoundaryState } from './boundary-state';

// ============= Table access =============

/** Read the boundary table (plain global — the executable assignment's target). */
export function getBoundaryTable(): Record<string, SSRBoundaryRecord> {
    return (typeof window !== 'undefined' && (window as any).__SIGX_BOUNDARIES__) || {};
}

/** Read one boundary record by component id. */
export function getBoundaryRecord(id: number): SSRBoundaryRecord | undefined {
    return getBoundaryTable()[String(id)];
}

// ============= Cleanup registry =============

/**
 * Pending hydration cleanup functions. Tracks observers, event listeners,
 * and timeouts created by deferred strategies so they can be cleaned up on
 * SPA navigation to prevent leaks.
 */
const _pendingCleanups: Set<() => void> = new Set();

/**
 * Clean up all pending deferred hydration observers and listeners.
 * Call on SPA navigation to prevent IntersectionObserver / matchMedia /
 * interaction-listener leaks for boundaries that haven't triggered yet.
 */
export function cleanupPendingHydrations(): void {
    for (const cleanup of _pendingCleanups) {
        try { cleanup(); } catch { /* ignore cleanup errors */ }
    }
    _pendingCleanups.clear();
}

// ============= Marker utilities =============

/** Parse the component id out of a `<!--$c:N-->` trailing marker, or null. */
export function parseMarkerId(marker: Comment): number | null {
    if (!marker.data.startsWith('$c:')) return null;
    const id = parseInt(marker.data.slice(3), 10);
    return isNaN(id) ? null : id;
}

/**
 * Single-pass marker index. Instead of walking the entire DOM for each
 * boundary lookup (O(N) per boundary = O(N²) total), build an index of all
 * component markers once and use it for O(1) lookups.
 */
let _markerIndex: Map<number, Comment> | null = null;

function buildMarkerIndex(): Map<number, Comment> {
    const index = new Map<number, Comment>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT, null);
    let node: Comment | null;
    while ((node = walker.nextNode() as Comment | null)) {
        const data = node.data;
        if (data.startsWith('$c:')) {
            const id = parseInt(data.slice(3), 10);
            if (!isNaN(id)) {
                index.set(id, node);
            }
        }
    }
    return index;
}

/** Invalidate the marker index (call when the DOM changes, e.g. after async streaming). */
export function invalidateMarkerIndex(): void {
    _markerIndex = null;
}

/**
 * The `<!--$c:ID-->` trailing marker for a boundary, via the cached marker
 * index (invalidate with {@link invalidateMarkerIndex} after DOM surgery).
 * Exported for packs that hydrate boundaries on their own schedule (#254 —
 * resumability's upgrade-on-write replicated this walk).
 */
export function findBoundaryMarker(id: number): Comment | null {
    // Public entry: honest null in non-DOM / pre-body environments instead
    // of throwing from the index build.
    if (typeof document === 'undefined' || !document.body) return null;
    if (!_markerIndex) {
        _markerIndex = buildMarkerIndex();
    }
    return _markerIndex.get(id) ?? null;
}

/**
 * Load a table boundary's component and hydrate it in place, right now —
 * the one-shot form of the strategy scheduler, for packs that own their own
 * wake-up (#254). Uses the CURRENT table record (mid-stream patches
 * included), core's chunk/registry resolution, and the same skip-placeholder
 * vs in-place dispatch as scheduled hydrations. Returns false when the
 * record, marker, or component cannot be resolved.
 */
export async function hydrateTableBoundary(id: number): Promise<boolean> {
    const record = getBoundaryRecord(id);
    if (!record) return false;
    const marker = findBoundaryMarker(id);
    if (!marker) return false;
    // A still-pending streamed boundary shows its async placeholder — the
    // real content hasn't arrived, so there is nothing to hydrate yet (the
    // scheduler bails the same way; sigx:async-ready will hydrate it).
    let prev: Node | null = marker.previousSibling;
    while (prev && prev.nodeType !== Node.ELEMENT_NODE) prev = prev.previousSibling;
    if (
        prev &&
        (prev as Element).hasAttribute?.('data-async-placeholder') &&
        record.flush !== 'skip'
    ) {
        return false;
    }
    const component = await loadBoundaryComponent(record);
    if (!component) return false;
    // Re-read after the await — a mid-stream patch may have replaced the
    // table entry while the chunk loaded (same discipline as the scheduler).
    const fresh = getBoundaryRecord(id) ?? record;
    if (fresh.flush === 'skip') {
        mountSkipBoundary(marker, component, fresh);
    } else {
        hydrateBoundaryInPlace(marker, component, fresh);
    }
    return true;
}

/**
 * Is this element the skip-SSR placeholder emitted by core's flush:'skip'
 * path for component `wantId`? Matches both the `data-boundary` id AND the
 * `display:contents` sentinel the skip path always sets, so user markup that
 * merely carries a coincidental `data-boundary="<id>"` is not mistaken for
 * the placeholder.
 */
export function isSkipPlaceholder(el: Element | null, wantId: number | null): boolean {
    return !!el && wantId != null
        && el.getAttribute?.('data-boundary') === String(wantId)
        && (el as HTMLElement).style?.display === 'contents';
}

/**
 * Find this component's content start and trailing marker from a walk
 * position. Mirrors hydrateComponent's marker selection: when components are
 * nested, SSR emits multiple contiguous `<!--$c:N-->` markers with child IDs
 * appearing BEFORE the parent's — choose the lowest-ID marker in the
 * contiguous run so we anchor on this (outermost) component.
 */
export function findComponentBoundaries(dom: Node | null): { contentStart: Node | null; trailingMarker: Comment | null } {
    const contentStart = dom;
    let trailingMarker: Comment | null = null;

    let current: Node | null = dom;
    let bestId = Infinity;
    let foundAnyMarker = false;
    while (current) {
        if (current.nodeType === Node.COMMENT_NODE) {
            const text = (current as Comment).data;
            if (text.startsWith('$c:')) {
                const id = parseInt(text.slice(3), 10);
                if (id < bestId) {
                    bestId = id;
                    trailingMarker = current as Comment;
                }
                foundAnyMarker = true;
            }
        } else if (foundAnyMarker) {
            // Passed this component's marker run into a sibling's content.
            break;
        }
        current = current.nextSibling;
    }

    return { contentStart, trailingMarker };
}

// ============= Strategy scheduling =============

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'focusin'] as const;

/**
 * Attach once-listeners for the interaction strategy on a target element.
 * The first event wins and removes the rest. No event replay (documented).
 */
function scheduleInteraction(target: Element | null, callback: () => void): void {
    if (!target) {
        // Nothing to interact with — hydrate immediately (mirrors the
        // visible strategy's no-element fallback).
        callback();
        return;
    }
    let cleanup: (() => void) | undefined;
    const fire = () => {
        if (cleanup) {
            _pendingCleanups.delete(cleanup);
            cleanup();
        }
        callback();
    };
    const options = { once: true, passive: true, capture: true } as AddEventListenerOptions;
    for (const type of INTERACTION_EVENTS) {
        target.addEventListener(type, fire, options);
    }
    cleanup = () => {
        for (const type of INTERACTION_EVENTS) {
            target.removeEventListener(type, fire, options);
        }
    };
    _pendingCleanups.add(cleanup);
}

/** First element node between `from` (inclusive) and `until` (exclusive). */
function firstElementBetween(from: Node | null, until: Node | null): Element | null {
    let current = from;
    while (current && current !== until) {
        if (current.nodeType === Node.ELEMENT_NODE) return current as Element;
        current = current.nextSibling;
    }
    return null;
}

function observeElementVisibility(
    target: Element | null,
    callback: () => void,
    rootMargin?: string
): IntersectionObserver | null {
    if (!target) {
        callback();
        return null;
    }
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                observer.disconnect();
                callback();
                break;
            }
        }
    }, rootMargin ? { rootMargin } : undefined);
    observer.observe(target);
    return observer;
}

/**
 * Schedule `callback` per a hydrate strategy. `target` supplies the DOM
 * anchor for element-bound strategies (visible, interaction); when null they
 * fire immediately. 'never' never fires. Cleanup entries are tracked for
 * {@link cleanupPendingHydrations}.
 */
export function scheduleByStrategy(
    strategy: BoundaryHydrate,
    media: string | undefined,
    target: Element | null,
    callback: () => void,
    visibleRootMargin?: string
): void {
    switch (strategy) {
        case 'load':
            callback();
            break;

        case 'idle': {
            let cancelled = false;
            let cleanup: (() => void) | undefined;
            const run = () => {
                if (cancelled) return;
                if (cleanup) _pendingCleanups.delete(cleanup);
                callback();
            };
            if ('requestIdleCallback' in window) {
                const handle = requestIdleCallback(run);
                cleanup = () => { cancelled = true; cancelIdleCallback(handle); };
            } else {
                const handle = setTimeout(run, 200);
                cleanup = () => { cancelled = true; clearTimeout(handle); };
            }
            _pendingCleanups.add(cleanup);
            break;
        }

        case 'visible': {
            let cleanupVis: (() => void) | undefined;
            const observer = observeElementVisibility(target, () => {
                if (cleanupVis) _pendingCleanups.delete(cleanupVis);
                callback();
            }, visibleRootMargin);
            if (observer) {
                cleanupVis = () => observer.disconnect();
                _pendingCleanups.add(cleanupVis);
            }
            break;
        }

        case 'media':
            if (media) {
                const mql = window.matchMedia(media);
                if (mql.matches) {
                    callback();
                } else {
                    let cleanupMedia: (() => void) | undefined;
                    const handler = (e: MediaQueryListEvent) => {
                        if (e.matches) {
                            mql.removeEventListener('change', handler);
                            if (cleanupMedia) _pendingCleanups.delete(cleanupMedia);
                            callback();
                        }
                    };
                    mql.addEventListener('change', handler);
                    cleanupMedia = () => mql.removeEventListener('change', handler);
                    _pendingCleanups.add(cleanupMedia);
                }
            }
            break;

        case 'interaction':
            scheduleInteraction(target, callback);
            break;

        case 'never':
            break;
    }
}

// ============= Mount/hydrate primitives =============

/** Build the mount vnode for a data-driven boundary (props from the table). */
function recordVNode(component: ComponentFactory, record: SSRBoundaryRecord): VNode {
    return {
        type: component as any,
        props: record.props || {},
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
function hydrateBoundaryInPlace(marker: Comment, component: ComponentFactory, record: SSRBoundaryRecord): void {
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

    seedBoundaryState(record.state);
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
function mountSkipBoundary(marker: Comment, component: ComponentFactory, record: SSRBoundaryRecord): void {
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

// ============= Data-driven scheduling (explicit mode) =============

/**
 * Schedule every boundary-table entry per its strategy — hydration without a
 * root walk (the `boundaries: 'explicit'` app default; islands'
 * `hydrateIslands()` entry). Records without a hydrate strategy, and
 * `hydrate: 'never'` records, schedule nothing.
 */
export function scheduleTableBoundaries(): void {
    // Entry point: never rely on stale cached DOM references.
    _markerIndex = null;

    const table = getBoundaryTable();
    for (const [idStr, record] of Object.entries(table)) {
        scheduleTableBoundary(parseInt(idStr, 10), record);
    }
}

function scheduleTableBoundary(id: number, record: SSRBoundaryRecord): void {
    const strategy = record.hydrate;
    if (!strategy || strategy === 'never') return;

    const marker = findBoundaryMarker(id);
    if (!marker) {
        if (__DEV__) {
            console.warn(`Boundary marker not found for id ${id}`);
        }
        return;
    }

    // A boundary still showing its streaming placeholder belongs to the
    // sigx:async-ready flow — its content has not arrived yet, and hydrating
    // the fallback would waste work and risk a double mount once the
    // replacement lands. (A placeholder already marked data-hydrated was
    // handled by that flow.)
    {
        let prev: Node | null = marker.previousSibling;
        while (prev && prev.nodeType !== Node.ELEMENT_NODE) {
            prev = prev.previousSibling;
        }
        if (prev && (prev as Element).hasAttribute?.('data-async-placeholder')) {
            return;
        }
    }

    const doHydrate = async () => {
        if (__DEV__) {
            console.log(`%c[Hydrate] 🎯 Strategy "${strategy}" fired for "${record.component}" — loading component...`, 'color: #673ab7; font-weight: bold');
        }
        // Re-read the record at fire time — a mid-stream patch may have
        // replaced the table since scheduling.
        const fresh = getBoundaryRecord(id) ?? record;
        const component = await loadBoundaryComponent(fresh);
        if (!component) {
            if (__DEV__) {
                console.warn(`Component "${fresh.component}" could not be resolved for hydration`);
            }
            return;
        }
        if (fresh.flush === 'skip') {
            mountSkipBoundary(marker, component, fresh);
        } else {
            hydrateBoundaryInPlace(marker, component, fresh);
        }
    };

    // Element-bound strategies anchor on the first element before the marker.
    let anchor: Node | null = marker.previousSibling;
    while (anchor && anchor.nodeType !== Node.ELEMENT_NODE) {
        anchor = anchor.previousSibling;
    }
    scheduleByStrategy(strategy, record.media, anchor as Element | null, doHydrate);
}

// ============= Walk-driven scheduling (auto mode) =============

/**
 * Schedule a boundary encountered during the root hydration walk. Receives
 * the LIVE vnode (children/slots intact) so in-place hydration matches what
 * an immediate walk would have produced. Returns the next DOM node after
 * this component's content.
 */
export function scheduleWalkedBoundary(
    vnode: VNode,
    dom: Node | null,
    parent: Node,
    record: SSRBoundaryRecord
): Node | null {
    const { contentStart, trailingMarker } = findComponentBoundaries(dom);

    const componentFactory = vnode.type as unknown as ComponentFactory;
    const componentName = componentFactory.__islandId || componentFactory.__name || 'Anonymous';

    // Skip async placeholders during the walk — the sigx:async-ready flow
    // hydrates them when their content streams in.
    if (contentStart && (contentStart as Element).hasAttribute?.('data-async-placeholder')) {
        if (componentName !== 'Anonymous') {
            registerComponent(componentName, componentFactory);
        }
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
        seedBoundaryState(fresh.state);
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
async function hydrateAsyncBoundary(container: Element, record: SSRBoundaryRecord): Promise<void> {
    // The hydrate axis holds for streamed content too: a boundary
    // explicitly marked 'never' stays static HTML.
    if (record.hydrate === 'never') {
        return;
    }
    if (!record.component) {
        if (__DEV__) {
            console.error(`[Hydrate] No component name in boundary record`);
        }
        return;
    }

    if (container.hasAttribute('data-hydrated')) {
        return;
    }
    // Mark synchronously, BEFORE any await, so duplicate triggers (the
    // leftover scan racing the sigx:async-ready event, or repeated events for
    // one id) can't both pass the guard above and double-mount the component.
    container.setAttribute('data-hydrated', '');

    const component = await loadBoundaryComponent(record);
    if (!component) {
        if (__DEV__) {
            console.error(`[Hydrate] Component "${record.component}" could not be resolved`);
        }
        return;
    }

    // Seed restored boundary signal state BEFORE hydrating.
    seedBoundaryState(record.state);
    try {
        hydrateComponent(recordVNode(component, record), container.firstChild, container);
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

/**
 * Listener for boundaries streaming in after initial hydration.
 */
let _asyncListenerSetup = false;

function ensureAsyncHydrationListener(): void {
    if (_asyncListenerSetup) return;
    _asyncListenerSetup = true;

    document.addEventListener('sigx:async-ready', (event: Event) => {
        const customEvent = event as CustomEvent;
        const { id } = customEvent.detail || {};

        invalidateMarkerIndex(); // DOM changed — rebuild marker index on next lookup

        const placeholder = document.querySelector(`[data-async-placeholder="${id}"]`);
        if (!placeholder) {
            if (__DEV__) {
                console.warn(`[Hydrate] Could not find placeholder for async boundary ${id}`);
            }
            return;
        }

        // The table patch preScript ran before this event fired — a plain
        // global read observes the freshest record.
        const record = getBoundaryRecord(Number(id));
        if (!record) {
            if (__DEV__) {
                console.warn(`[Hydrate] No boundary record for async component ${id}`);
            }
            return;
        }

        void hydrateAsyncBoundary(placeholder as Element, record).catch(reportAsyncHydrateError);
    });
}

// Set up the listener immediately when this module loads (browser only)
if (typeof document !== 'undefined') {
    ensureAsyncHydrationListener();
}
