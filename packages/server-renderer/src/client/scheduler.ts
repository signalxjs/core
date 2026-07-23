/**
 * The boundary scheduler (rfc-ssr-platform §1.2) — the EAGER half of
 * selective hydration. Reads the per-request `window.__SIGX_BOUNDARIES__`
 * table and schedules each boundary per its hydrate strategy:
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
 * This module (the `@sigx/server-renderer/client/scheduler` entry) must not
 * value-import anything from the sigx family: the page pays only for trigger
 * wiring at load. The hydration EXECUTOR — the renderer, `hydrateComponent`,
 * the in-place/skip-mount primitives — lives in `./hydration-core` and is
 * dynamically imported by {@link loadHydrationCore} on the first strategy
 * that actually fires (the resume-loader pattern: cached promise, a failed
 * load clears the cache so the next trigger retries).
 *
 * Generalized from the islands pack's scheduler; the islands package
 * re-exports this machinery and stays a mapping from `client:*` directives
 * to boundary records.
 */

import type { SSRBoundaryRecord, BoundaryHydrate } from '../boundary';
import { resolveClientPlugins } from './plugin-registry';
import { loadBoundaryComponent } from './chunk-loader';

// The rest of the eager surface, re-exported so packs can build their
// zero-runtime client entries on this module alone: plugin registration,
// the component registry (all lazy `() => import()` thunks), the chunk
// loader, and the state-staging seam. Everything here shares the invariant
// documented above — no sigx-family value imports.
export {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    resolveClientPlugins,
    hasPendingClientPlugins,
    getCurrentAppContext,
    setCurrentAppContext
} from './plugin-registry';
export type { ClientPluginSource, LazyClientPlugin } from './plugin-registry';
export {
    registerComponent,
    registerComponents,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    HydrationRegistry
} from './registry';
export type { ComponentFactory, LazyComponentLoader } from './registry';
export { loadBoundaryComponent, prefetchBoundaryChunks } from './chunk-loader';
export { seedBoundaryState, consumeBoundaryState } from './boundary-state';

/** The lazily-loaded executor surface consumed by the scheduler. */
type HydrationCore = typeof import('./hydration-core');

// ============= Lazy hydration core =============

let _core: Promise<HydrationCore> | null = null;

/**
 * Load the hydration executor (renderer + `hydrateComponent` + the
 * mount/hydrate primitives) and resolve lazily-registered client plugins.
 * Cached after the first call; a failed load resets the cache so the next
 * trigger retries. Every boundary-scheduled hydration path awaits this
 * before touching a component — which is what guarantees the synchronous
 * client plugin hooks see resolved plugins.
 */
export function loadHydrationCore(): Promise<HydrationCore> {
    if (!_core) {
        const p = Promise.all([import('./hydration-core.js'), resolveClientPlugins()])
            .then(([mod]) => mod, (err) => {
                if (_core === p) _core = null;
                throw err;
            });
        _core = p;
    }
    return _core;
}

// ============= Table access =============

/**
 * The `__SIGX_BOUNDARIES__` seam's shape at its accessor pair — the
 * canonical contract lives in `docs/seams.md`. Null-prototype record of
 * component id (stringified) → boundary record.
 */
type BoundaryTableGlobal = { __SIGX_BOUNDARIES__?: Record<string, SSRBoundaryRecord> };

/** Read the boundary table (plain global — the executable assignment's target). */
export function getBoundaryTable(): Record<string, SSRBoundaryRecord> {
    return (
        (typeof window !== 'undefined' &&
            (window as unknown as BoundaryTableGlobal).__SIGX_BOUNDARIES__) ||
        // Null-prototype like the real table: an empty fallback must not
        // resurface inherited keys to callers indexing by untrusted strings.
        (Object.create(null) as Record<string, SSRBoundaryRecord>)
    );
}

/** Read one boundary record by component id. */
export function getBoundaryRecord(id: number): SSRBoundaryRecord | undefined {
    return getBoundaryTable()[String(id)];
}

/**
 * Install (or overwrite) boundary records — the write half of the table
 * accessor pair. A single-flight refresh envelope's `records` patch
 * (rfc-server §6.3) enters the table through here, exactly as a streamed
 * `boundaryPatchJs` assignment would. Same null-prototype-target discipline
 * as `assignmentJs`: keys can be user-derived, so `__proto__` must land as
 * plain data, never as a prototype write.
 */
export function installBoundaryRecords(
    patch: Record<string | number, SSRBoundaryRecord>
): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as BoundaryTableGlobal;
    w.__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), w.__SIGX_BOUNDARIES__, patch);
}

/**
 * Remove a retired boundary's record — a refresh swapped its DOM for a
 * fresh id, and a stale entry would satisfy later lookups for a boundary
 * that no longer exists.
 */
export function removeBoundaryRecord(id: number): void {
    if (typeof window === 'undefined') return;
    const table = (window as unknown as BoundaryTableGlobal).__SIGX_BOUNDARIES__;
    if (table) delete table[String(id)];
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
    // One retry: a mid-stream patch can replace the record while the chunk
    // loads; the second pass re-validates everything against the new record.
    for (let attempt = 0; attempt < 2; attempt++) {
        const record = getBoundaryRecord(id);
        if (!record) return false;
        const marker = findBoundaryMarker(id);
        if (!marker || !marker.isConnected) return false;
        // The element before the marker is the content root. Its absence
        // means there is nothing to hydrate — return false instead of
        // letting the in-place step warn-and-noop.
        let prev: Node | null = marker.previousSibling;
        while (prev && prev.nodeType !== Node.ELEMENT_NODE) prev = prev.previousSibling;
        if (!prev) return false;
        // A still-pending streamed boundary shows its ASYNC placeholder —
        // the real content hasn't arrived yet (sigx:async-ready will hydrate
        // it). Regardless of flush: skip boundaries use the data-boundary
        // placeholder, never this one.
        if ((prev as Element).hasAttribute?.('data-async-placeholder')) {
            return false;
        }
        const [core, component] = await Promise.all([
            loadHydrationCore(),
            loadBoundaryComponent(record)
        ]);
        if (!component) return false;
        // Post-await re-validation: the table and the DOM may both have
        // changed while the chunk loaded.
        const fresh = getBoundaryRecord(id);
        if (!fresh) return false; // record removed mid-flight
        if (fresh.component !== record.component || fresh.chunk?.url !== record.chunk?.url) {
            continue; // record replaced — one full re-pass with the new one
        }
        const liveMarker = findBoundaryMarker(id);
        if (!liveMarker || !liveMarker.isConnected) return false;
        if (fresh.flush === 'skip') {
            core.mountSkipBoundary(liveMarker, component, fresh);
        } else {
            core.hydrateBoundaryInPlace(liveMarker, component, fresh);
        }
        return true;
    }
    return false;
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
 * position, searching the half-open sibling range `[dom, regionEnd)`.
 *
 * SSR allocates component ids from a pre-order counter (`nextId()`), entered
 * BEFORE a component renders its children, and emits the id as a TRAILING
 * `<!--$c:N-->` marker. That gives one invariant the pick rests on:
 *
 *   For a component with id N, every marker between its content start and its
 *   own marker belongs to a DESCENDANT (id > N), and every later sibling in
 *   the same parent also has id > N. The only markers with id < N belong to
 *   ANCESTORS, and they always come after N's own marker.
 *
 * So the lowest-id marker in `[dom, regionEnd)` is always this component's,
 * whatever mix of nested components and plain sibling content follows it.
 *
 * `regionEnd` — the enclosing component's trailing marker — is what keeps an
 * ancestor's (lower) id out of the range; the walk threads it down through
 * every position that shares a DOM parent with that marker, and resets it to
 * null when descending into an element, whose own child list bounds the scan.
 * Without it the scan needed a break heuristic, which mistook plain sibling
 * content for the end of the component and latched a CHILD's marker (#373).
 */
export function findComponentBoundaries(
    dom: Node | null,
    regionEnd: Node | null = null
): { contentStart: Node | null; trailingMarker: Comment | null } {
    const contentStart = dom;
    let trailingMarker: Comment | null = null;

    let current: Node | null = dom;
    let bestId = Infinity;
    while (current && current !== regionEnd) {
        if (current.nodeType === Node.COMMENT_NODE) {
            const text = (current as Comment).data;
            if (text.startsWith('$c:')) {
                const id = parseInt(text.slice(3), 10);
                if (id < bestId) {
                    bestId = id;
                    trailingMarker = current as Comment;
                }
            }
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
export function firstElementBetween(from: Node | null, until: Node | null): Element | null {
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
        // The executor and the component chunk fetch in parallel: the first
        // trigger pays one round trip for both, not two.
        const [core, component] = await Promise.all([
            loadHydrationCore(),
            loadBoundaryComponent(fresh)
        ]);
        if (!component) {
            if (__DEV__) {
                console.warn(`Component "${fresh.component}" could not be resolved for hydration`);
            }
            return;
        }
        if (fresh.flush === 'skip') {
            core.mountSkipBoundary(marker, component, fresh);
        } else {
            core.hydrateBoundaryInPlace(marker, component, fresh);
        }
    };

    // Element-bound strategies anchor on the first element before the marker.
    let anchor: Node | null = marker.previousSibling;
    while (anchor && anchor.nodeType !== Node.ELEMENT_NODE) {
        anchor = anchor.previousSibling;
    }
    scheduleByStrategy(strategy, record.media, anchor as Element | null, doHydrate);
}

// ============= Streamed-boundary hydration (sigx:async-ready) =============

function reportAsyncHydrateError(err: unknown): void {
    if (__DEV__) {
        console.error('[Hydrate] Failed to hydrate streamed async boundary:', err);
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

        // The executor loads on demand — a page whose only boundaries stream
        // in still defers the runtime until content actually arrives.
        loadHydrationCore()
            .then((core) => core.hydrateAsyncBoundary(placeholder as Element, record))
            .catch(reportAsyncHydrateError);
    });
}

// Set up the listener immediately when this module loads (browser only)
if (typeof document !== 'undefined') {
    ensureAsyncHydrationListener();
}
