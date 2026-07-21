/**
 * The islands client plugin hooks — the LAZY half of the islands client.
 *
 * State restoration needs `createRestoringSignal` (real signals — the
 * reactivity runtime) and the walk fallback needs `scheduleWalkedBoundary`
 * (the hydration executor), so this module lives behind the same dynamic
 * boundary as the hydration core: `hydrateIslands()` registers it as a lazy
 * plugin source, resolved by `loadHydrationCore()` before the first
 * component hydrates. The eager entry (`./hydrate-islands`) must never
 * import this module statically.
 */

import type { SSRPlugin } from '@sigx/server-renderer';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { scheduleWalkedBoundary, consumeBoundaryState } from '@sigx/server-renderer/client';
import type { VNode, ComponentSetupContext } from 'sigx';
import { createRestoringSignal } from './restore-signal';
import { getHydrationDirective, filterClientDirectives, CLIENT_DIRECTIVE_PREFIX } from '../client-directives';
import type { HydrationStrategy } from '../types';

/**
 * Schedule an island encountered during the root hydration walk — the
 * directive spelling mapped onto a boundary record for the core scheduler.
 * Used as the plugin's walk fallback for islands the boundary table did not
 * record (core's table interception claims recorded ones first).
 * Returns the next DOM node after this component's content.
 *
 * Lives on the lazy side: it feeds `scheduleWalkedBoundary`, which closes
 * over the hydration executor — and it is only reachable from the root
 * walk, which is already heavy by definition.
 */
export function scheduleComponentHydration(
    vnode: VNode,
    dom: Node | null,
    parent: Node,
    strategy: { strategy: HydrationStrategy; media?: string },
    regionEnd: Node | null = null
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
    // regionEnd travels through untouched: the core scheduler needs it to
    // pick this island's own trailing marker rather than a child's (#373).
    return scheduleWalkedBoundary(vnode, dom, parent, record, regionEnd);
}

/**
 * The islands client hooks as a standalone SSRPlugin — what
 * `hydrateIslands()` registers lazily, and what `islandsPlugin()`'s client
 * half delegates to (one copy of the logic, two registration shapes).
 */
export const islandsClientHooks: SSRPlugin = {
    name: 'islands',

    client: {
        transformComponentContext(
            _vnode: VNode,
            componentCtx: ComponentSetupContext
        ): ComponentSetupContext | void {
            // Restore the server-captured signal state staged by the core
            // scheduler just before this island's hydrateComponent call.
            // Presence of pending state scopes this to islands —
            // non-island components have none and are left untouched
            // (mirrors the server hook guarding on the client:* directive).
            const state = consumeBoundaryState();
            if (!state) return;

            componentCtx.signal = createRestoringSignal(state) as ComponentSetupContext['signal'];
            return componentCtx;
        },

        hydrateComponent(
            vnode: VNode,
            dom: Node | null,
            parent: Node,
            regionEnd?: Node | null
        ): Node | null | undefined {
            // Walk fallback for islands the boundary table did not record
            // (a stripped blob, or markup rendered without the table):
            // core's table interception claims recorded boundaries before
            // this hook runs, so this only fires for directive-carrying
            // components with no record.
            const strategy = vnode.props ? getHydrationDirective(vnode.props) : null;

            if (!strategy) return undefined; // Not an island — let core handle it

            return scheduleComponentHydration(vnode, dom, parent, strategy, regionEnd ?? null);
        }

        // No afterHydrate hook anymore: the core hydrator runs the
        // leftover streamed-boundary scan itself.
    }
};
