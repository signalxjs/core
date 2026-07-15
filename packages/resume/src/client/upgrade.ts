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
 * Marker location uses core's exported `findBoundaryMarker` (#260). The
 * in-place hydration stays pack-owned: core's `hydrateTableBoundary` awaits
 * the chunk load INSIDE its call, and the restore hook must only be armed
 * around the synchronous `hydrateComponent` window (a concurrent boundary
 * hydrating during that await would otherwise hit the hook).
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
    findBoundaryMarker,
    invalidateMarkerIndex,
    registerClientPlugin,
    getClientPlugins
} from '@sigx/server-renderer/client';
import type { SSRPlugin } from '@sigx/server-renderer';
import type { VNode, ComponentSetupContext } from 'sigx';
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
            // Boundary ROOT only: hydrateComponent recurses into children
            // while currentUpgradingScope is still set, and the record's
            // state belongs to the root — a child restoring from it (or
            // reporting into _live) would cross-wire same-named signals.
            if (upgrading._rootRestored) return;
            upgrading._rootRestored = true;
            componentCtx.signal = createRestoringSignal(
                (upgrading._record?.state as Record<string, unknown>) ?? {},
                (name, live) => {
                    upgrading._live![name] = live;
                }
            ) as ComponentSetupContext['signal'];
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

/**
 * Load the boundary's component chunk and hydrate it in place.
 *
 * Every failure path (missing record/component/marker/container, a throwing
 * hydration) resets the scope to 'resumed' so later interactions can retry —
 * a permanently 'upgrading' scope would silently eat all future writes.
 */
export async function scheduleUpgrade(scope: InternalScope): Promise<void> {
    try {
        await runUpgrade(scope);
    } finally {
        if (scope._status !== 'upgraded') {
            scope._status = 'resumed';
            scope._live = null;
        }
    }
}

async function runUpgrade(scope: InternalScope): Promise<void> {
    // Late table installs can fill a record the scope missed at creation —
    // pin it on the scope so the restore hook seeds from the SAME record.
    if (!scope._record) scope._record = getBoundaryRecord(scope._id) ?? null;
    const record = scope._record;
    if (!record) return; // detached scope — nothing to upgrade

    const component = await loadBoundaryComponent(record);
    if (!component) {
        if (__DEV__) {
            console.warn(
                `[sigx resume] Cannot upgrade boundary ${scope._id}: component ` +
                `"${record.component ?? '?'}" is neither registered nor chunk-addressable. ` +
                `The scope stays resumed; the next write retries.`
            );
        }
        return;
    }

    let marker = findBoundaryMarker(scope._id);
    if (marker && !marker.isConnected) {
        // Core's marker index caches nodes; DOM surgery (streaming
        // replacement, SPA teardown) can leave stale entries — rebuild once.
        invalidateMarkerIndex();
        marker = findBoundaryMarker(scope._id);
    }
    if (!marker || !marker.isConnected) {
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
    // restore hook (root component only — _rootRestored gates children).
    ensureRestoreHook();
    scope._live = {};
    scope._rootRestored = false;
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
