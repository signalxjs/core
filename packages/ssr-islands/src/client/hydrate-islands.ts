/**
 * Islands client entry points — thin facades over the core boundary
 * hydrator in `@sigx/server-renderer/client` (rfc-ssr-platform §1.2:
 * selective hydration IS the hydrator; islands is the directive mapping).
 */

import type { VNode } from 'sigx';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import {
    scheduleTableBoundaries,
    scheduleWalkedBoundary,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    seedBoundaryState,
    consumeBoundaryState
} from '@sigx/server-renderer/client';
import type { HydrationStrategy } from '../types';
import { filterClientDirectives, CLIENT_DIRECTIVE_PREFIX } from '../client-directives';

export { cleanupPendingHydrations, invalidateMarkerIndex };

/**
 * Hydrate islands based on their strategies (selective hydration) — the
 * standalone islands-mode entry (no root walk). Equivalent to hydrating an
 * app whose default is `boundaries: 'explicit'`.
 */
export function hydrateIslands(): void {
    scheduleTableBoundaries();
}

/**
 * Schedule an island encountered during the root hydration walk — the
 * directive spelling mapped onto a boundary record for the core scheduler.
 * Used as the plugin's walk fallback for islands the boundary table did not
 * record (core's table interception claims recorded ones first).
 * Returns the next DOM node after this component's content.
 */
export function scheduleComponentHydration(
    vnode: VNode,
    dom: Node | null,
    parent: Node,
    strategy: { strategy: HydrationStrategy; media?: string }
): Node | null {
    // Strip client:* before delegating — the directive vocabulary is
    // islands-owned; core never filters props. Mutate props on THIS vnode
    // rather than cloning it: core attaches hydration state to the passed
    // vnode and retains it for later patching/unmount, so its object
    // identity must be preserved. Only rewrite when a directive is present.
    if (vnode.props) {
        for (const key in vnode.props) {
            if (key.startsWith(CLIENT_DIRECTIVE_PREFIX)) {
                vnode.props = filterClientDirectives(vnode.props);
                break;
            }
        }
    }

    const record: SSRBoundaryRecord = strategy.strategy === 'only'
        ? { flush: 'skip', hydrate: 'load' }
        : { hydrate: strategy.strategy, media: strategy.media };
    return scheduleWalkedBoundary(vnode, dom, parent, record);
}

/**
 * Stage island server-state before a `hydrateComponent` call — facade over
 * the core staging seam (the islands plugin's client
 * `transformComponentContext` consumes it to seed restored signals).
 */
export function seedPendingServerState(state: Record<string, any> | null | undefined): void {
    seedBoundaryState(state);
}

/** Read and clear the pending island server-state. */
export function consumePendingServerState(): Record<string, any> | null {
    return consumeBoundaryState();
}
