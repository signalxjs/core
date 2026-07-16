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
    type AsyncStateName,
    type MatchArms,
    CELL,
    STALE,
    matchAsyncState,
    normalizeError,
    makeUnhandledReporter,
    makeAbortController,
    inertAbortSignal,
} from './shared.js';
import { peekRestored, invalidateRestored, writeBack } from './restore.js';
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
    });

    /** Last-good value — survives a failed refresh (handed to the error arm as `stale`). */
    let stale: T | null = null;
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
                state.st = state.data !== null ? 'refreshing' : 'pending';
                state.err = null;
            });
            release();
            entry = acquire(key, force);
            held = entry;
        });

        try {
            const v = (await entry.p) as T;
            if (id !== runId) return; // superseded — never writes state
            stale = v;
            batch(() => {
                state.st = 'ready';
                state.data = v;
                state.err = null;
            });
        } catch (e) {
            if (id !== runId) return; // superseded — never writes `.error`
            const err = normalizeError(e);
            batch(() => {
                // value/error are mutually exclusive — a failed fetch clears
                // data so success and error branches can't co-render. The
                // last-good value survives in `stale` for the error arm.
                state.st = 'errored';
                state.data = null;
                state.err = err;
            });
        }
    }

    function setKey(canon: string | null, raw: unknown): void {
        untrack(() => {
            rawArg = raw;
            if (canon === canonKey) return; // same canonical identity — no-op
            canonKey = canon;
            runId++; // supersede any in-flight observation
            release();
            stale = null;

            if (canon === null) {
                batch(() => {
                    state.st = 'idle';
                    state.data = null;
                    state.err = null;
                });
                return;
            }

            const restored = peekRestored(canon);
            if (restored.hit) {
                const v = restored.value as T;
                stale = v;
                batch(() => {
                    state.st = 'ready';
                    state.data = v;
                    state.err = null;
                });
                return;
            }

            // Hard reset — the old key's value must never flash under the new key.
            batch(() => {
                state.st = 'pending';
                state.data = null;
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

    const cell: AsyncState<T> = {
        get state() {
            return state.st;
        },
        get value() {
            return state.data;
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
                    error: state.err,
                    stale,
                    retry: () => void refresh(),
                    onUnhandledError: reportUnhandled,
                },
                arms
            );
        },
        refresh,
    };
    Object.defineProperty(cell, CELL, { value: true });
    Object.defineProperty(cell, STALE, { get: () => stale });

    return {
        cell,
        setKey,
        dispose() {
            runId++;
            release();
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
        error: null,
        loading: false,
        match<R>(arms: MatchArms<never, R>): R | undefined {
            return (arms.idle ?? arms.pending)?.();
        },
        refresh: () => Promise.resolve(),
    };
    Object.defineProperty(cell, CELL, { value: true });
    Object.defineProperty(cell, STALE, { value: null });
    return Object.freeze(cell);
})();
