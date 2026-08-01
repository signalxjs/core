/**
 * The async-cell engine behind `useData` — the client state machine for one
 * keyed read: key changes, in-flight dedupe, supersede, refresh, and the
 * SSR-blob restore/writeback cycle.
 *
 * Pinned semantics (docs/rfc-async.md rev 8):
 * - key change ⇒ hard reset: value cleared, state 'pending' (no wrong-data flash)
 * - same-key refresh() ⇒ value kept, state 'refreshing'
 * - a superseded run NEVER writes state or `.error`
 * - the underlying fetch is aborted only when this cell was its sole consumer
 * - `refresh()` never rejects — failures land on `.error`
 */

import { signal, batch, untrack, detectAccess } from '@sigx/reactivity';
import type { ComponentSetupContext } from '../component-types.js';
import {
    type AsyncFetcherContext,
    type AsyncState,
    type AsyncStateImpl,
    type AsyncStateName,
    type MatchArms,
    CELL,
    matchAsyncState,
    normalizeError,
    makeUnhandledReporter,
    makeAbortController,
    inertAbortSignal,
} from './shared.js';
import { peekRestored, invalidateRestored, writeBack, restoredKeys } from './restore.js';
import { preparePattern } from './key-match.js';
import { isLiveClient } from './environment.js';

/**
 * In-flight dedupe for keyed client fetches (concurrent mounts share one
 * run). Refcounted so a shared fetch survives one consumer's unmount, while
 * a sole consumer's release aborts it.
 */
interface InflightEntry {
    key: string;
    p: Promise<unknown>;
    ctrl: AbortController | null;
    refs: number;
}
const inflight = new Map<string, InflightEntry>();

/**
 * Mounted cells by canonical key — the registry {@link invalidateKeys} sweeps
 * (#484).
 *
 * `inflight` above looks like this but is not: it is an in-flight DEDUPE map,
 * keyed by a run that is currently happening, and it empties as fetches
 * settle. Nothing here could address a settled, mounted cell by its key, which
 * is why a mutation's `invalidates` reached only reads carrying a `cache`
 * option — those live in `@sigx/cache`'s `CacheStore.entries`, and every other
 * read is served by the default engine and was invisible to it.
 *
 * Refresh is mechanism, not cache POLICY: the mounted-cell registry is
 * something only core can hold, so it lives here and the cache pack delegates.
 * That is also what makes `invalidates` work with no cache pack installed.
 */
const mountedByKey = new Map<string, Set<(force: boolean) => void>>();

function registerMounted(key: string, run: (force: boolean) => void): void {
    let set = mountedByKey.get(key);
    if (!set) mountedByKey.set(key, (set = new Set()));
    set.add(run);
}

function unregisterMounted(key: string, run: (force: boolean) => void): void {
    const set = mountedByKey.get(key);
    if (!set) return;
    set.delete(run);
    if (set.size === 0) mountedByKey.delete(key);
}

/**
 * Refresh every mounted `useData` cell whose canonical key matches any of
 * `patterns`, and drop the matching entries from the SSR transfer blob.
 *
 * Both halves matter. Refreshing the mounted cells is the visible effect; the
 * blob sweep is what stops a stale value coming BACK. `startRun` writes every
 * successful fetch into `__SIGX_ASYNC__`, and `setKey` restores from it as
 * `ready` without fetching — so an invalidation that skipped the blob would be
 * undone by the next unmount/remount (a client-side navigation away and back),
 * with no refetch at all, until a full page load.
 *
 * ONE fetch per key, not one per cell: several components can read the same
 * key (that is what the `inflight` dedupe above is for), and `refresh()`
 * FORCES — it drops the shared in-flight entry so the next acquire starts a
 * new run. Having every cell force would make N mounted readers issue N
 * requests and leave all but the last observing a superseded one. So the first
 * cell on a key forces, and the rest join the run it just started.
 *
 * Returns the number of keys touched, so a caller can dev-warn when a pattern
 * matched nothing (a silent no-op is how #484 stayed invisible for so long).
 *
 * @internal
 */
export function invalidateKeys(patterns: ReadonlyArray<string | readonly unknown[]>): number {
    if (patterns.length === 0) return 0;
    const matchers = patterns.map(preparePattern);
    let touched = 0;

    // Collect first: a run may settle synchronously and re-register, and
    // mutating the map mid-iteration is how that turns into a missed cell.
    const hits: Array<Array<(force: boolean) => void>> = [];
    for (const [key, set] of mountedByKey) {
        if (!matchers.some(m => m.match(key))) continue;
        touched++;
        invalidateRestored(key);
        if (set.size > 0) hits.push([...set]);
    }
    // The blob can hold keys nothing is mounted on (a route the user has left,
    // or one SSR transferred and the client has not read yet) — those must be
    // swept too, or remounting restores the stale value.
    for (const key of restoredKeys()) {
        if (mountedByKey.has(key)) continue; // already swept above
        if (!matchers.some(m => m.match(key))) continue;
        touched++;
        invalidateRestored(key);
    }
    for (const perKey of hits) {
        // First forces the refetch; the others join that same in-flight run.
        for (let i = 0; i < perKey.length; i++) perKey[i](i === 0);
    }
    return touched;
}

/** @internal — engine handle returned to `useData` (the `cell` is the public object). */
export interface DataCellHandle<T> {
    cell: AsyncState<T>;
    /** Point the cell at a (canonical) key — `null` means skip ⇒ 'idle'. */
    setKey(canon: string | null, raw: unknown): void;
    /** Stop observing: supersede any in-flight run and drop the fetch ref. */
    dispose(): void;
}

/**
 * Create the reactive cell for one `useData` call. `instance` is the
 * setup-time component context — captured for unhandled-error bubbling.
 *
 * @internal
 */
export function createDataCell<T>(
    fetcher: (arg: unknown, ctx: AsyncFetcherContext) => Promise<T>,
    instance: ComponentSetupContext<any, any, any> | null
): DataCellHandle<T> {
    const state = signal({
        st: 'idle' as AsyncStateName,
        data: null as T | null,
        err: null as Error | null,
        /**
         * Whether `data` is a VALUE, as opposed to "nothing yet" (#485).
         *
         * `data !== null` cannot answer that: a fetch legitimately resolving
         * `null` — a "not found" read — is indistinguishable from an unsettled
         * cell. Both survive a failed fetch (SWR-through-error): last-good is
         * `data` itself, in every state — there is no hidden stale channel.
         * Cleared only on key change and skip.
         */
        has: false,
    });
    /** Supersede token: bumped by every new run, key change, and dispose. */
    let runId = 0;
    let canonKey: string | null = null;
    let rawArg: unknown = null;
    /** The in-flight entry this cell currently holds a ref on. */
    let held: InflightEntry | null = null;

    const reportUnhandled = makeUnhandledReporter(instance, 'useData');

    function release(): void {
        const e = held;
        if (!e) return;
        held = null;
        e.refs--;
        if (e.refs === 0) {
            // Sole consumer gone — abort the fetch (a no-op after settle) and
            // drop the entry unless a forced refresh already replaced it.
            e.ctrl?.abort();
            if (inflight.get(e.key) === e) inflight.delete(e.key);
        }
    }

    function acquire(key: string, force: boolean): InflightEntry {
        // refresh() forces a fresh fetch instead of joining an in-flight one
        // (consumers of the old promise keep their entry — unaffected).
        if (force) inflight.delete(key);

        let e = inflight.get(key);
        if (!e) {
            // Keyed fetches may be SHARED across components, so the fetcher's
            // signal belongs to the ENTRY (aborted when the last consumer
            // releases), never to whichever component happened to start it.
            const ctrl = makeAbortController();
            const ctx: AsyncFetcherContext = { signal: ctrl ? ctrl.signal : inertAbortSignal() };
            let p: Promise<unknown>;
            const invoke = () => {
                try {
                    p = Promise.resolve(fetcher(rawArg, ctx));
                } catch (err) {
                    p = Promise.reject(err);
                }
            };
            if (__DEV__) {
                // Fetchers run untracked — a signal read inside one will not
                // re-run anything. Catch the (synchronous) case in dev.
                const access = detectAccess(invoke);
                if (access) {
                    console.warn(
                        `[useData] the fetcher for key "${key}" read a reactive value — fetchers run ` +
                        'untracked, so changes to it will NOT re-run the fetch. Put the parameter in ' +
                        "the key instead: useData(() => ['thing', param.value] as const, fetcher)."
                    );
                }
            } else {
                invoke();
            }

            const entry: InflightEntry = { key, p: p!, ctrl, refs: 0 };
            inflight.set(key, entry);
            // Shared settle handler: write back + identity-guarded cleanup.
            // The identity guard covers both directions — a forced refresh
            // must not have its NEWER entry evicted by a stale settle, and a
            // superseded entry must not write a stale value over fresh data.
            void p!.then(
                (v) => {
                    if (inflight.get(key) === entry) {
                        writeBack(key, v);
                        inflight.delete(key);
                    }
                },
                () => {
                    if (inflight.get(key) === entry) inflight.delete(key);
                }
            );
            e = entry;
        }
        e.refs++;
        return e;
    }

    async function startRun(force: boolean): Promise<void> {
        if (canonKey === null) return;
        const id = ++runId;
        const key = canonKey;

        let entry!: InflightEntry;
        // untrack: when triggered from the key watcher this runs inside a
        // tracked effect — reads here (state, fetcher internals) must not
        // become dependencies of the key watch.
        untrack(() => {
            // Fetching means the restored value (if any) is no longer the
            // truth — invalidate so later mounts fetch instead of restoring.
            invalidateRestored(key);
            batch(() => {
                state.st = state.has ? 'refreshing' : 'pending';
                state.err = null;
            });
            release();
            entry = acquire(key, force);
            held = entry;
        });

        try {
            const v = (await entry.p) as T;
            if (id !== runId) return; // superseded — never writes state
            batch(() => {
                state.st = 'ready';
                state.data = v;
                state.has = true;
                state.err = null;
            });
        } catch (e) {
            if (id !== runId) return; // superseded — never writes `.error`
            const err = normalizeError(e);
            batch(() => {
                // SWR-through-error: `data`/`has` survive — the app decides
                // whether stale content outlives a failure by reading them,
                // and a later retry runs as 'refreshing', never flashing a
                // skeleton over content the error arm was showing.
                state.st = 'errored';
                state.err = err;
            });
        }
    }

    /**
     * Stable identity in the mounted registry: `invalidateKeys` holds this,
     * not the cell, so the Set entry can be removed on key change and dispose
     * without depending on `refresh`'s closure identity.
     */
    const onInvalidate = (force: boolean): void => { void startRun(force); };

    function setKey(canon: string | null, raw: unknown): void {
        untrack(() => {
            rawArg = raw;
            if (canon === canonKey) return; // same canonical identity — no-op
            if (canonKey !== null) unregisterMounted(canonKey, onInvalidate);
            canonKey = canon;
            if (canon !== null) registerMounted(canon, onInvalidate);
            runId++; // supersede any in-flight observation
            release();

            if (canon === null) {
                batch(() => {
                    state.st = 'idle';
                    state.data = null;
                    state.has = false;
                    state.err = null;
                });
                return;
            }

            const restored = peekRestored(canon);
            if (restored.hit) {
                const v = restored.value as T;
                batch(() => {
                    state.st = 'ready';
                    state.data = v;
                    state.has = true;
                    state.err = null;
                });
                return;
            }

            // Hard reset — the old key's value must never flash under the new key.
            batch(() => {
                state.st = 'pending';
                state.data = null;
                state.has = false;
                state.err = null;
            });
            // SSR without a provider should never happen (the server walk
            // installs one), but guard anyway: never run fetchers outside a
            // live client here (non-web runtimes declare via declareLiveClient).
            if (isLiveClient()) void startRun(false);
        });
    }

    function refresh(): Promise<void> {
        if (canonKey === null) return Promise.resolve();
        return startRun(true);
    }

    // Built as the wide impl shape, cast to the union at the seam — the
    // invariants the cast asserts are dev-checked in matchAsyncState.
    const impl: AsyncStateImpl<T> = {
        get state() {
            return state.st;
        },
        get value() {
            return state.data;
        },
        get hasValue() {
            return state.has;
        },
        get error() {
            return state.err;
        },
        get loading() {
            return state.st === 'pending';
        },
        match<R>(arms: MatchArms<T, R>): R | undefined {
            return matchAsyncState<T, R>(
                {
                    state: state.st,
                    value: state.data,
                    hasValue: state.has,
                    error: state.err,
                    retry: () => void refresh(),
                    onUnhandledError: reportUnhandled,
                },
                arms
            );
        },
        refresh,
    };
    Object.defineProperty(impl, CELL, { value: true });

    return {
        cell: impl as AsyncState<T>,
        setKey,
        dispose() {
            runId++;
            release();
            if (canonKey !== null) unregisterMounted(canonKey, onInvalidate);
            canonKey = null;
        },
    };
}

/**
 * The shared skip cell: `state 'idle'`, nothing to fetch, `refresh()` is a
 * resolved no-op. Returned when a key resolves falsy on the provider (SSR)
 * path — the client path keeps a live cell so the key can turn truthy later.
 *
 * @internal
 */
export const INERT_IDLE_CELL: AsyncState<never> = (() => {
    const cell: AsyncState<never> = {
        state: 'idle',
        value: null,
        hasValue: false,
        error: null,
        loading: false,
        match<R>(arms: MatchArms<never, R>): R | undefined {
            return (arms.idle ?? arms.pending)?.();
        },
        refresh: () => Promise.resolve(),
    };
    Object.defineProperty(cell, CELL, { value: true });
    return Object.freeze(cell);
})();
