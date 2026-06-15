/**
 * Async component hydration
 *
 * Handles hydration of components that stream in after the initial page load.
 * Listens for `sigx:async-ready` events dispatched by the $SIGX_REPLACE script.
 *
 * Moved from @sigx/server-renderer.
 */

import type { VNode } from 'sigx';
import { loadIslandComponent } from './chunk-loader';
import type { IslandInfo } from './types';
import { invalidateIslandCache, getIslandData } from './island-context';
import { invalidateMarkerIndex, seedPendingServerState } from './hydrate-islands';

// Import hydrateComponent from server-renderer core
import { hydrateComponent } from '@sigx/server-renderer/client';

/**
 * Check for async components that were skipped during hydration walk
 * but whose $SIGX_REPLACE script already ran (event fired before listener was ready).
 */
export function hydrateLeftoverAsyncComponents(container: Element): void {
    const placeholders = container.querySelectorAll('[data-async-placeholder]:not([data-hydrated])');
    if (placeholders.length === 0) return;

    invalidateIslandCache();
    const islandData = getIslandData();

    for (const placeholder of placeholders) {
        const id = placeholder.getAttribute('data-async-placeholder');
        if (!id) continue;

        const info = islandData[id];
        // Hydrate every streamed-in async island, not only those that captured
        // signal state — an async component with no tracked state must still
        // become interactive. (Matches the sigx:async-ready listener path,
        // which gates on `info` alone.)
        if (info) {
            hydrateAsyncComponent(placeholder as Element, info);
        }
    }
}

/**
 * Set up listener for async components streaming in.
 */
let _asyncListenerSetup = false;

function ensureAsyncHydrationListener(): void {
    if (_asyncListenerSetup) return;
    _asyncListenerSetup = true;

    document.addEventListener('sigx:async-ready', (event: Event) => {
        const customEvent = event as CustomEvent;
        const { id, state } = customEvent.detail || {};

        invalidateIslandCache();
        invalidateMarkerIndex(); // DOM changed — rebuild marker index on next lookup

        const placeholder = document.querySelector(`[data-async-placeholder="${id}"]`);
        if (!placeholder) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`[Hydrate] Could not find placeholder for async component ${id}`);
            }
            return;
        }

        const islandData = getIslandData();
        const info = islandData[String(id)];

        if (!info) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`[Hydrate] No island data for async component ${id}`);
            }
            return;
        }

        hydrateAsyncComponent(placeholder as Element, info);
    });
}

// Set up the listener immediately when this module loads (browser only)
if (typeof document !== 'undefined') {
    ensureAsyncHydrationListener();
}

/**
 * Hydrate an async component that just streamed in.
 */
async function hydrateAsyncComponent(container: Element, info: IslandInfo): Promise<void> {
    if (!info.componentId) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`[Hydrate] No componentId in island info`);
        }
        return;
    }

    if (container.hasAttribute('data-hydrated')) {
        return;
    }

    const component = await loadIslandComponent(info);
    if (!component) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`[Hydrate] Component "${info.componentId}" could not be resolved`);
        }
        return;
    }

    const props = info.props || {};

    container.setAttribute('data-hydrated', '');

    const vnode: VNode = {
        type: component as any,
        props: props,
        key: null,
        children: [],
        dom: null
    };

    // Seed restored island signal state BEFORE hydrating (mirrors the islands
    // hydrate path) — the old `serverState` 4th arg to hydrateComponent is gone.
    seedPendingServerState(info.state);
    hydrateComponent(vnode, container.firstChild, container);
}
