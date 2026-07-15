/**
 * Upgrade-on-write (#241): the moment a resumed handler first WRITES a
 * signal, the component chunk loads and that one boundary hydrates for real.
 *
 * The DOM still shows what the server rendered, so hydration runs with the
 * ORIGINAL serialized state (a mismatch would leave stale text or trigger a
 * remount) and the buffered writes replay through the live signals
 * afterwards — the render effect then patches the DOM to the current values.
 * Handlers never notice: their facades return buffered values in the
 * interim and re-point to the live signals after.
 *
 * `wake()` is the same machinery for `__resumeMode: 'hydrate'` boundaries
 * (delegation saw a `data-sigx-wake` carrier): full hydration, no QRLs, no
 * write replay — there is nothing resumed to replay.
 *
 * The marker/container location replicates two small private core helpers
 * (`findBoundaryMarker` / `hydrateBoundaryInPlace`); #241 tracks exporting
 * them from @sigx/server-renderer/client (seam PR b).
 *
 * Note: the record's state is handed to the restoring factory through
 * `currentUpgradingScope`, NOT core's seed/consume staging — a co-installed
 * islands plugin consumes staged state unconditionally, and bypassing the
 * staging keeps the packs from ever racing over it.
 */

import {
    getBoundaryRecord,
    loadBoundaryComponent,
    hydrateComponent,
    registerClientPlugin,
    getClientPlugins
} from '@sigx/server-renderer/client';
import type { SSRPlugin } from '@sigx/server-renderer';
import type { VNode, ComponentSetupContext, signal } from 'sigx';
import type { InternalScope } from './scope';
import { getScope } from './scope';
import { createRestoringSignal } from './restore-signal';

let currentUpgradingScope: InternalScope | null = null;

/** The scope being upgraded right now (read by the restore hook). */
export function getCurrentUpgradingScope(): InternalScope | null {
    return currentUpgradingScope;
}

/**
 * The restore hook: during an upgrade's `hydrateComponent`, swap the setup
 * context's signal factory so named signals seed from the ORIGINAL state and
 * report themselves into the upgrading scope. Registered lazily (first
 * upgrade) so app-less pages need no explicit client bootstrap; other
 * boundaries are untouched (no `currentUpgradingScope` → pass through), so
 * a co-installed islands plugin never sees interference.
 */
const RESTORE_HOOK: SSRPlugin = {
    name: 'resume-upgrade',
    client: {
        transformComponentContext(
            _vnode: VNode,
            componentCtx: ComponentSetupContext
        ): ComponentSetupContext | void {
            const upgrading = currentUpgradingScope;
            if (!upgrading) return;
            componentCtx.signal = createRestoringSignal(
                (upgrading._record?.state as Record<string, unknown>) ?? {},
                (name, live) => {
                    upgrading._live![name] = live;
                }
            ) as typeof signal;
            (componentCtx as ComponentSetupContext & { $sigxB?: string }).$sigxB = String(upgrading._id);
            return componentCtx;
        }
    }
};

function ensureRestoreHook(): void {
    // Presence check, not a flag — plugin registries can be cleared (tests,
    // SPA teardown) and the hook must survive that.
    if (!getClientPlugins().includes(RESTORE_HOOK)) registerClientPlugin(RESTORE_HOOK);
}

/** `<!--$c:id-->` trailing marker for a boundary (core's helper is private). */
function findBoundaryMarker(id: number): Comment | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    const want = `$c:${id}`;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if ((node as Comment).data === want) return node as Comment;
    }
    return null;
}

/** Load the boundary's component chunk and hydrate it in place. */
export async function scheduleUpgrade(scope: InternalScope): Promise<void> {
    const record = scope._record ?? getBoundaryRecord(scope._id);
    if (!record) return; // detached scope — nothing to upgrade

    const component = await loadBoundaryComponent(record);
    if (!component) {
        if (__DEV__) {
            console.warn(
                `[sigx resume] Cannot upgrade boundary ${scope._id}: component ` +
                `"${record.component ?? '?'}" is neither registered nor chunk-addressable. ` +
                `Writes keep buffering; the DOM will not update.`
            );
        }
        return;
    }

    const marker = findBoundaryMarker(scope._id);
    if (!marker) {
        if (__DEV__) {
            console.warn(`[sigx resume] Cannot upgrade boundary ${scope._id}: trailing marker not found.`);
        }
        return;
    }
    let container: Node | null = marker.previousSibling;
    while (container && container.nodeType !== Node.ELEMENT_NODE) {
        container = container.previousSibling;
    }
    if (!container || !container.parentNode) {
        if (__DEV__) {
            console.warn(`[sigx resume] Cannot upgrade boundary ${scope._id}: no element before its marker.`);
        }
        return;
    }

    const vnode = {
        type: component,
        props: record.props || {},
        key: null,
        children: [],
        dom: null
    } as unknown as VNode;

    // Hydrate with the ORIGINAL state — the DOM matches it. The restoring
    // factory reports each live named signal into scope._live via the
    // restore hook.
    ensureRestoreHook();
    scope._live = {};
    currentUpgradingScope = scope;
    try {
        hydrateComponent(vnode, container, container.parentNode, marker);
    } finally {
        currentUpgradingScope = null;
    }

    // Replay buffered writes in order — the render effect patches the DOM.
    for (const [name, value] of scope._pendingWrites) {
        const live = scope._live[name];
        if (live) live.value = value;
        else if (__DEV__) {
            console.warn(
                `[sigx resume] Buffered write to "${name}" has no live signal after upgrade — ` +
                `the component no longer declares a named signal "${name}".`
            );
        }
    }
    scope._pendingWrites.length = 0;
    scope._status = 'upgraded';
}

/**
 * Fully hydrate a `__resumeMode: 'hydrate'` boundary (delegation hit a
 * `data-sigx-wake` carrier). No replay — its listeners only exist after
 * hydration (documented, matching the transform's dev warning).
 */
export async function wake(boundaryId: number): Promise<void> {
    const scope = getScope(boundaryId);
    if (scope._status !== 'resumed') return; // already upgrading/upgraded
    scope._status = 'upgrading';
    await scheduleUpgrade(scope);
}
