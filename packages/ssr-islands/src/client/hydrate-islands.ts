/**
 * Island hydration strategies and scheduling
 *
 * Handles selective/deferred hydration based on client:* directives:
 * - client:load — hydrate immediately
 * - client:idle — hydrate during browser idle time
 * - client:visible — hydrate when element scrolls into view
 * - client:media — hydrate when a media query matches
 * - client:only — mount fresh (no SSR content)
 *
 * Moved from @sigx/server-renderer.
 */

import {
    VNode,
    render,
} from 'sigx';
import { registerComponent, type ComponentFactory } from './registry';
import { loadIslandComponent } from './chunk-loader';
import type { IslandInfo } from './types';

// Import from server-renderer core.
import { hydrateComponent } from '@sigx/server-renderer/client';

// ============= Module State =============

// Optional host-wired accessors for app context + server-state restoration. They
// stay null unless a host calls initIslandHydration(); core does not yet expose a
// client hydration seam to wire them, so they are currently inert (#120).
let _getCurrentAppContext: (() => any) | null = null;
let _setCurrentAppContext: ((ctx: any) => void) | null = null;
let _setPendingServerState: ((state: Record<string, any> | null) => void) | null = null;

/**
 * Pending hydration cleanup functions.
 * Tracks observers, event listeners, and timeouts created by deferred hydration
 * strategies (client:idle, client:visible, client:media) so they can be cleaned
 * up on SPA navigation to prevent leaks.
 */
const _pendingCleanups: Set<() => void> = new Set();

/**
 * Clean up all pending deferred hydration observers and listeners.
 * Call this on SPA navigation to prevent IntersectionObserver / matchMedia leaks
 * for components that haven't triggered yet.
 *
 * @example
 * ```ts
 * router.beforeEach(() => {
 *     cleanupPendingHydrations();
 * });
 * ```
 */
export function cleanupPendingHydrations(): void {
    for (const cleanup of _pendingCleanups) {
        try { cleanup(); } catch { /* ignore cleanup errors */ }
    }
    _pendingCleanups.clear();
}

/**
 * Optional wiring hook: install host-provided accessors for app context and
 * server-state restoration. NOT currently called — the islands plugin cannot wire
 * these until core exposes a client hydration seam (#120), so app-context
 * propagation and tracked-signal restoration to deferred islands stay inert until
 * then. Kept as the ready integration point.
 */
export function initIslandHydration(fns: {
    getCurrentAppContext: () => any;
    setCurrentAppContext: (ctx: any) => void;
    setPendingServerState: (state: Record<string, any> | null) => void;
}): void {
    _getCurrentAppContext = fns.getCurrentAppContext;
    _setCurrentAppContext = fns.setCurrentAppContext;
    _setPendingServerState = fns.setPendingServerState;
}

/**
 * Seed the pending island server-state before a `hydrateComponent` call so the
 * hydrated island restores its tracked signal values. No-op unless a host has
 * wired a restoration sink via {@link initIslandHydration}. Shared by the
 * async-streaming hydration path (`hydrate-async.ts`).
 */
export function seedPendingServerState(state: Record<string, any> | null | undefined): void {
    if (state) _setPendingServerState?.(state);
}

// ============= Full-tree Component Hydration Scheduling =============

/**
 * Schedule component hydration based on strategy.
 * Returns the next DOM node after this component's content.
 */
export function scheduleComponentHydration(
    vnode: VNode,
    dom: Node | null,
    parent: Node,
    strategy: { strategy: 'load' | 'idle' | 'visible' | 'media' | 'only'; media?: string }
): Node | null {
    const { contentStart, trailingMarker } = findComponentBoundaries(dom);

    const componentFactory = vnode.type as unknown as ComponentFactory;
    const componentName = componentFactory.__islandId || componentFactory.__name || 'Anonymous';

    // Skip async placeholders during hydration walk.
    if (contentStart && (contentStart as Element).hasAttribute?.('data-async-placeholder')) {
        if (componentName !== 'Anonymous') {
            registerComponent(componentName, componentFactory);
        }
        return trailingMarker ? trailingMarker.nextSibling : dom;
    }

    const capturedAppContext = _getCurrentAppContext?.();

    const doHydrate = () => {
        // Remove our cleanup entry since we're actually hydrating
        if (cleanupFn) _pendingCleanups.delete(cleanupFn);

        const prevAppContext = _getCurrentAppContext?.();
        _setCurrentAppContext?.(capturedAppContext);
        try {
            hydrateComponent(vnode, contentStart, parent, trailingMarker);
        } finally {
            _setCurrentAppContext?.(prevAppContext);
        }
    };

    let cleanupFn: (() => void) | null = null;

    switch (strategy.strategy) {
        case 'load':
            doHydrate();
            break;

        case 'idle': {
            let cancelled = false;
            if ('requestIdleCallback' in window) {
                const handle = requestIdleCallback(() => {
                    if (!cancelled) doHydrate();
                });
                cleanupFn = () => { cancelled = true; cancelIdleCallback(handle); };
            } else {
                const handle = setTimeout(() => {
                    if (!cancelled) doHydrate();
                }, 200);
                cleanupFn = () => { cancelled = true; clearTimeout(handle); };
            }
            _pendingCleanups.add(cleanupFn);
            break;
        }

        case 'visible': {
            const observer = observeComponentVisibility(contentStart, trailingMarker, doHydrate);
            if (observer) {
                cleanupFn = () => observer.disconnect();
                _pendingCleanups.add(cleanupFn);
            }
            break;
        }

        case 'media':
            if (strategy.media) {
                const mql = window.matchMedia(strategy.media);
                if (mql.matches) {
                    doHydrate();
                } else {
                    const handler = (e: MediaQueryListEvent) => {
                        if (e.matches) {
                            mql.removeEventListener('change', handler);
                            if (cleanupFn) _pendingCleanups.delete(cleanupFn);
                            doHydrate();
                        }
                    };
                    mql.addEventListener('change', handler);
                    cleanupFn = () => mql.removeEventListener('change', handler);
                    _pendingCleanups.add(cleanupFn);
                }
            }
            break;

        case 'only': {
            // Skip-SSR: the server emitted an empty <div data-island> placeholder
            // (no component content). Mount the component fresh into it instead of
            // hydrating. Fall back to in-place hydration when there is no
            // placeholder (back-compat with content that was SSR'd in place).
            // Bound the search by trailingMarker so we never drift into a sibling's
            // DOM when this component produced no leading element. Match the
            // placeholder's data-island id against this component's marker id so we
            // don't mistake user markup that happens to carry data-island.
            const wantId = markerIslandId(trailingMarker);
            let ph: Node | null = contentStart;
            while (ph && ph !== trailingMarker && ph.nodeType !== Node.ELEMENT_NODE) ph = ph.nextSibling;
            if (ph && ph !== trailingMarker && wantId != null && (ph as Element).getAttribute?.('data-island') === wantId) {
                const container = ph as Element;
                container.innerHTML = '';
                // Mount under the captured app context, mirroring doHydrate().
                const prevAppContext = _getCurrentAppContext?.();
                _setCurrentAppContext?.(capturedAppContext);
                try {
                    render(vnode, container);
                } finally {
                    _setCurrentAppContext?.(prevAppContext);
                }
            } else {
                doHydrate();
            }
            break;
        }
    }

    return trailingMarker ? trailingMarker.nextSibling : dom;
}

/** Extract the component id from a `$c:N` marker comment, or null if not one. */
function markerIslandId(marker: Comment | null): string | null {
    if (!marker) return null;
    const data = marker.data;
    return data.startsWith('$c:') ? data.slice(3) : null;
}

function findComponentBoundaries(dom: Node | null): { contentStart: Node | null; trailingMarker: Comment | null } {
    const contentStart = dom;
    let trailingMarker: Comment | null = null;

    // Mirror @sigx/server-renderer/client hydrateComponent's marker selection:
    // when components are nested, SSR emits multiple contiguous <!--$c:N-->
    // markers with child IDs appearing BEFORE the parent's. Picking the first
    // marker would anchor on a child and return the wrong nextSibling, causing
    // the walk to skip/rehydrate the wrong DOM range. Choose the lowest-ID
    // marker in the contiguous run so we anchor on this (outermost) component.
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

function observeComponentVisibility(contentStart: Node | null, trailingMarker: Comment | null, callback: () => void): IntersectionObserver | null {
    let targetElement: Element | null = null;
    let current = contentStart;

    while (current && current !== trailingMarker) {
        if (current.nodeType === Node.ELEMENT_NODE) {
            targetElement = current as Element;
            break;
        }
        current = current.nextSibling;
    }

    if (!targetElement) {
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
    }, { rootMargin: '50px' });

    observer.observe(targetElement);
    return observer;
}

// ============= Islands-based Hydration (from __SIGX_ISLANDS__) =============

/**
 * Hydrate islands based on their strategies (selective hydration)
 */
export function hydrateIslands(): void {
    // Always start with a fresh marker index — this is the entry point
    // and should not rely on stale cached DOM references.
    _markerIndex = null;

    const dataScript = document.getElementById('__SIGX_ISLANDS__');
    if (!dataScript) {
        return;
    }

    let islandData: Record<string, IslandInfo>;
    try {
        islandData = JSON.parse(dataScript.textContent || '{}');
    } catch {
        console.error('Failed to parse island data');
        return;
    }

    for (const [idStr, info] of Object.entries(islandData)) {
        const id = parseInt(idStr, 10);
        scheduleHydration(id, info);
    }
}

function scheduleHydration(id: number, info: IslandInfo): void {
    const marker = findIslandMarker(id);
    if (!marker) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(`Island marker not found for id ${id}`);
        }
        return;
    }

    const doHydrate = async () => {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`%c[Islands] 🎯 Strategy "${info.strategy}" fired for "${info.componentId}" — loading component...`, 'color: #673ab7; font-weight: bold');
        }
        const component = await loadIslandComponent(info);
        if (!component) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`Component "${info.componentId}" could not be resolved for hydration`);
            }
            return;
        }
        if (info.strategy === 'only') {
            mountClientOnly(marker, component, info);
        } else {
            hydrateIsland(marker, component, info);
        }
    };

    // visible needs the marker for IntersectionObserver — handle it here
    if (info.strategy === 'visible') {
        let cleanupVis: (() => void) | undefined;
        const observer = observeVisibility(marker, () => {
            if (cleanupVis) _pendingCleanups.delete(cleanupVis);
            doHydrate();
        });
        if (observer) {
            cleanupVis = () => observer.disconnect();
            _pendingCleanups.add(cleanupVis);
        }
        return;
    }

    scheduleByStrategy(info, doHydrate);
}

/**
 * Schedule a callback based on a hydration strategy.
 * Note: 'visible' is handled directly in scheduleHydration because it needs the DOM marker.
 */
function scheduleByStrategy(info: IslandInfo, callback: () => void): void {
    switch (info.strategy) {
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

        case 'media':
            if (info.media) {
                const mql = window.matchMedia(info.media);
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

        case 'only':
            callback();
            break;

        default:
            callback();
            break;
    }
}

/**
 * Single-pass marker index.
 * Instead of walking the entire DOM for each island lookup (O(N) per island = O(N²) total),
 * build an index of all component markers once and use it for O(1) lookups.
 */
let _markerIndex: Map<number, Comment> | null = null;

function buildMarkerIndex(): Map<number, Comment> {
    const index = new Map<number, Comment>();
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_COMMENT,
        null
    );

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

/**
 * Invalidate the marker index (call when DOM changes, e.g., after async component streaming).
 */
export function invalidateMarkerIndex(): void {
    _markerIndex = null;
}

function findIslandMarker(id: number): Comment | null {
    if (!_markerIndex) {
        _markerIndex = buildMarkerIndex();
    }
    return _markerIndex.get(id) ?? null;
}

function observeVisibility(marker: Comment, callback: () => void): IntersectionObserver | null {
    let node: Node | null = marker.previousSibling;
    while (node && node.nodeType !== Node.ELEMENT_NODE) {
        node = node.previousSibling;
    }

    if (!node) {
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
    });

    observer.observe(node as Element);
    return observer;
}

function hydrateIsland(marker: Comment, component: ComponentFactory, info: IslandInfo): void {
    let container: Node | null = marker.previousSibling;
    while (container && container.nodeType !== Node.ELEMENT_NODE) {
        container = container.previousSibling;
    }

    if (!container || container.nodeType !== Node.ELEMENT_NODE) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('No element found for island hydration');
        }
        return;
    }

    const props = info.props || {};

    if (info.state) {
        _setPendingServerState?.(info.state);
    }

    const vnode: VNode = {
        type: component as any,
        props: props,
        key: null,
        children: [],
        dom: null
    };

    const parent = container.parentNode!;
    hydrateComponent(vnode, container, parent, marker);
}

function mountClientOnly(marker: Comment, component: ComponentFactory, info: IslandInfo): void {
    let placeholder = marker.previousSibling;
    while (placeholder && placeholder.nodeType !== Node.ELEMENT_NODE) {
        placeholder = placeholder.previousSibling;
    }

    // The placeholder's data-island id must match this island's marker id —
    // otherwise it's not our skip-SSR placeholder (e.g. user markup carrying
    // data-island, or content SSR'd in place predating skip-SSR). In that case
    // hydrate in place instead of mounting into the wrong element.
    const wantId = markerIslandId(marker);
    if (!placeholder || wantId == null || (placeholder as Element).getAttribute?.('data-island') !== wantId) {
        hydrateIsland(marker, component, info);
        return;
    }

    const props = info.props || {};
    const container = placeholder as Element;
    container.innerHTML = '';

    const vnode: VNode = {
        type: component as any,
        props,
        key: null,
        children: [],
        dom: null
    };

    render(vnode, container);
}
