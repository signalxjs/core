/**
 * Single-flight boundary refresh — the client half (rfc-server §6.3, #313).
 *
 * Implements the `__SIGX_SERVERFN_BOUNDARIES__` seam the fn stub calls
 * (docs/seams.md): `collect()` inventories the page's refreshable resume
 * boundaries for a mutation's request sidecar; `apply(entries, seq)` patches
 * the response's fresh HTML/state in.
 *
 * Apply is status-gated per entry, all synchronous (state↔DOM atomicity is
 * the same invariant upgrade-on-write hydration relies on):
 *
 * - `'upgrading'` — DROP: the in-flight upgrade reads `record.state` at an
 *   unpredictable point; live state wins (rfc-server §6.3). Same for a
 *   resumed scope holding buffered writes — they are a pending upgrade
 *   retry, i.e. later user intent.
 * - `'upgraded'` — skip the HTML; write the fresh state through the live
 *   signals (whole-value per name, the capture grain). Guarded by a
 *   dispatch-order seq so an earlier-dispatched, later-arriving mutation
 *   never overwrites a newer one's writes.
 * - resumed / never-touched — DOM swap: replace everything from the content
 *   root through the old `<!--$c:oldId-->` marker with the fresh HTML
 *   (which carries its own marker and `data-sigx-b` under the fresh id),
 *   retire the old ids' records and scopes, install the re-render's table
 *   patch. Delegation needs no re-wiring — dispatch reads the attributes
 *   off whatever DOM is present. Overlap safety falls out of retirement:
 *   a stale response's `for` id no longer has a record and drops.
 *
 * Every drop is silent convergence, not an error — the mutation already
 * succeeded, and declined/dropped boundaries catch up through `$cache`
 * invalidation.
 */

import {
    getBoundaryTable,
    getBoundaryRecord,
    installBoundaryRecords,
    removeBoundaryRecord,
    findBoundaryMarker,
    invalidateMarkerIndex
} from '@sigx/server-renderer/client';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { reviveFromServer } from 'sigx/internals';
import { peekScope, dropScope, onResumeReset } from './scope';

/** One `$boundaries` envelope entry (produced by `createBoundaryRefresh`). */
interface RefreshEntry {
    for: number;
    id: number;
    html: string;
    state?: Record<string, unknown>;
    records?: Record<string, SSRBoundaryRecord>;
}

/**
 * Client-chosen id floor for the next mutation's re-render (rfc-server
 * §6.3): far above any page's own counter, stride-advanced per collect so
 * concurrent mutations' renders stay marker-disjoint (the server walks past
 * its highest emitted marker per descriptor; the stride bounds a whole
 * call's range).
 */
let nextBase = 1 << 20;
const BASE_STRIDE = 1 << 17;

/** Last-applied dispatch seq per UPGRADED boundary (the swap path needs no
 *  guard — retirement drops stale responses by construction). */
const lastApplied = new Map<number, number>();
onResumeReset(() => {
    lastApplied.clear();
});

function collect(): { base: number; refresh: unknown[] } | null {
    const table = getBoundaryTable();
    const refresh: unknown[] = [];
    for (const key in table) {
        const id = Number(key);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const record = table[key];
        if (!record || record.hydrate !== 'never' || !record.component) continue;
        if (record.refreshable === false) continue;
        // An in-flight upgrade would drop the entry anyway — save the bytes.
        if (peekScope(id)?._status === 'upgrading') continue;
        refresh.push({
            id,
            component: record.component,
            // Verbatim encoded snapshot — the server side revives it.
            ...(record.props ? { props: record.props } : {})
        });
    }
    if (refresh.length === 0) return null;
    const base = nextBase;
    nextBase += BASE_STRIDE;
    return { base, refresh };
}

function apply(entries: unknown[], seq: number): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
        try {
            applyEntry(entry as RefreshEntry, seq);
        } catch (error) {
            if (__DEV__) console.error('[sigx resume] boundary refresh apply failed:', error);
        }
    }
}

function applyEntry(entry: RefreshEntry, seq: number): void {
    if (entry === null || typeof entry !== 'object') return;
    const forId = entry.for;
    if (!Number.isSafeInteger(forId) || forId <= 0) return;

    const scope = peekScope(forId);
    if (scope?._status === 'upgrading') return; // upgrade wins
    if (scope?._status === 'upgraded') {
        applyLiveState(forId, entry, seq);
        return;
    }
    // Buffered writes are a pending upgrade retry — later user intent wins.
    if (scope && scope._pendingWrites.length > 0) return;
    applySwap(forId, entry);
}

/** Upgraded boundary: fresh state through the live signals, no HTML. */
function applyLiveState(forId: number, entry: RefreshEntry, seq: number): void {
    if ((lastApplied.get(forId) ?? 0) > seq) return; // stale response
    lastApplied.set(forId, seq);
    const scope = peekScope(forId)!;
    const fresh = reviveFromServer(entry.state) as Record<string, unknown> | undefined;
    if (!fresh || typeof fresh !== 'object' || !scope._live) return;
    for (const name in fresh) {
        const live = scope._live[name];
        if (live) {
            live.value = fresh[name];
        } else if (__DEV__) {
            console.warn(
                `[sigx resume] refreshed state "${name}" has no live signal on boundary ` +
                `${forId} — the component does not declare it at its root; skipped.`
            );
        }
    }
    // Keep the table in step for SPA teardown / re-resume readers.
    const record = getBoundaryRecord(forId);
    if (record && entry.state && typeof entry.state === 'object') record.state = entry.state;
}

/** Resumed boundary: swap `[content root … old marker]` for the fresh HTML. */
function applySwap(forId: number, entry: RefreshEntry): void {
    // A missing record means the id was already retired (an overlapping
    // refresh won) or never existed — drop either way.
    if (!getBoundaryRecord(forId)) return;
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0) return;
    if (typeof entry.html !== 'string' || entry.html === '') return;

    let marker = findBoundaryMarker(forId);
    if (!marker || !marker.isConnected) {
        invalidateMarkerIndex();
        marker = findBoundaryMarker(forId);
    }
    if (!marker || !marker.isConnected) return; // boundary left the DOM

    // Content root: nearest element before the trailing marker — the same
    // single-element-root contract upgrade-on-write hydration relies on.
    let container: Node | null = marker.previousSibling;
    while (container && container.nodeType !== Node.ELEMENT_NODE) {
        container = container.previousSibling;
    }
    const parent = marker.parentNode;
    if (!container || !parent) return;

    // Focused text entry inside the swap range: dropping the WHOLE entry is
    // the only atomic option — swapping DOM but not state (or vice versa)
    // breaks the state↔DOM invariant hydration depends on.
    const active = document.activeElement;
    const activeInside = !!active && (container as Element).contains(active);
    if (activeInside && isTextEntry(active!)) return;
    const refocusId = activeInside ? (active as HTMLElement).id : '';

    // Context-sensitive parse — a bare template/innerHTML would mangle
    // table-context roots, and the fresh `<!--$c:newId-->` comment must
    // survive parsing.
    const range = document.createRange();
    range.selectNode(container as Element);
    const fragment = range.createContextualFragment(entry.html);

    // Remove [container … marker] inclusive — formatting whitespace and
    // stale child markers ride along — collecting every retired boundary id
    // (attributes AND child marker comments) as we go.
    const retired = new Set<number>([forId]);
    const anchor = marker.nextSibling;
    let node: Node | null = container;
    while (node) {
        const next: Node | null = node.nextSibling;
        collectRetiredIds(node, retired);
        parent.removeChild(node);
        if (node === marker) break;
        node = next;
    }
    parent.insertBefore(fragment, anchor);

    for (const id of retired) {
        dropScope(id);
        removeBoundaryRecord(id);
        lastApplied.delete(id);
    }
    if (entry.records && typeof entry.records === 'object') {
        installBoundaryRecords(entry.records);
    }
    invalidateMarkerIndex();

    // Best-effort refocus for non-text focus (the "user clicked the
    // mutating button" case) — by element id only.
    if (refocusId) {
        const again = document.getElementById(refocusId);
        if (again) again.focus();
    }
}

/** Ids owned by a removed node: its own/descendant `data-sigx-b` carriers
 *  plus any `$c:` child markers, so no stale record or scope survives. */
function collectRetiredIds(node: Node, into: Set<number>): void {
    if (node.nodeType === Node.COMMENT_NODE) {
        const data = (node as Comment).data;
        if (data.startsWith('$c:')) {
            const id = parseInt(data.slice(3), 10);
            if (!isNaN(id)) into.add(id);
        }
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const own = element.getAttribute('data-sigx-b');
    if (own !== null) {
        const id = parseInt(own, 10);
        if (!isNaN(id)) into.add(id);
    }
    for (const carrier of element.querySelectorAll('[data-sigx-b]')) {
        const id = parseInt(carrier.getAttribute('data-sigx-b')!, 10);
        if (!isNaN(id)) into.add(id);
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_COMMENT, null);
    let comment: Comment | null;
    while ((comment = walker.nextNode() as Comment | null)) {
        if (comment.data.startsWith('$c:')) {
            const id = parseInt(comment.data.slice(3), 10);
            if (!isNaN(id)) into.add(id);
        }
    }
}

function isTextEntry(element: Element): boolean {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
        return !/^(?:button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(
            (element as HTMLInputElement).type
        );
    }
    return (element as HTMLElement).isContentEditable === true;
}

/**
 * Stamp the seam. Called at `@sigx/resume/client` module scope — by the
 * time any handler can issue an RPC, the client runtime has evaluated, so
 * the stub always finds the seam on a resumable page. First stamp wins
 * (double-eval guard under HMR / duplicated module graphs).
 */
export function installBoundaryRefreshSeam(): void {
    const host = globalThis as {
        __SIGX_SERVERFN_BOUNDARIES__?: { collect: typeof collect; apply: typeof apply };
    };
    if (host.__SIGX_SERVERFN_BOUNDARIES__) return;
    host.__SIGX_SERVERFN_BOUNDARIES__ = { collect, apply };
}

/** Test-only symmetry: remove the seam iff it is ours. */
export function uninstallBoundaryRefreshSeam(): void {
    const host = globalThis as {
        __SIGX_SERVERFN_BOUNDARIES__?: { collect?: typeof collect };
    };
    if (host.__SIGX_SERVERFN_BOUNDARIES__?.collect === collect) {
        delete host.__SIGX_SERVERFN_BOUNDARIES__;
    }
}
