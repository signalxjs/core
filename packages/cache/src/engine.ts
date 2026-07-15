/**
 * The cache engine — an AsyncEngine (rfc-async §7 provider seam) whose
 * cells read through the CacheStore.
 *
 * Reads WITHOUT a `cache` option delegate to core's default engine
 * untouched (pinned semantics guaranteed by core's own test suite); a
 * convenience `invalidate()` (= refresh) is attached either way. Reads WITH
 * `cache` options get store-backed cells: staleTime freshness, shared
 * entries across mounts, keepPreviousData across key changes, gcTime
 * retention, focus/interval revalidation, and `mutate()` write-through.
 */

import { signal, batch, untrack } from '@sigx/reactivity';
import type { AsyncFetcherContext, AsyncState, MatchArms } from '@sigx/runtime-core';
import {
    matchAsyncState,
    makeUnhandledReporter,
    defaultAsyncEngine,
    isLiveClient,
    type AsyncEngine,
    type AsyncReadHandle,
} from '@sigx/runtime-core/internals';
import { CacheStore, type CacheEntry, type EntrySubscriber } from './store.js';
import type { CacheOptions, CacheActionOptions } from './options.js';

type Fetcher = (arg: unknown, ctx: AsyncFetcherContext) => Promise<unknown>;
type StateName = 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';

/** The state object cached reads return — AsyncState plus the pack methods. */
export interface CachedAsyncState<T> extends AsyncState<T> {
    /** Drop this key's cached value and refetch (all mounted consumers update). */
    invalidate(): void;
    /** Optimistic write-through: update the cached value in place (every mounted consumer re-renders). */
    mutate(update: T | ((current: T | null) => T)): void;
}

function createCachedRead<T>(
    store: CacheStore,
    fetcher: Fetcher,
    cache: CacheOptions,
    instance: Parameters<AsyncEngine['read']>[2]
): AsyncReadHandle<T> {
    const staleTime = cache.staleTime ?? store.defaultStaleTime;
    const policy = {
        gcTime: cache.gcTime ?? store.defaultGcTime,
        revalidateOnFocus: cache.revalidateOnFocus ?? false,
        revalidateOnInterval: cache.revalidateOnInterval,
    };
    const keepPreviousData = cache.keepPreviousData ?? false;

    const state = signal({
        st: 'idle' as StateName,
        data: null as T | null,
        err: null as Error | null,
    });

    let canonKey: string | null = null;
    let rawArg: unknown = null;
    let entry: CacheEntry | null = null;
    /** Last-good value handed to the error arm (mirrors core's stale param). */
    let staleVal: T | null = null;
    /** Previous key's value — shown through a key change under keepPreviousData. */
    let previousData: T | null = null;
    let disposed = false;

    const reportUnhandled = makeUnhandledReporter(instance, 'useData');

    /** Derive the cell's state from the current entry — the single source of truth. */
    function apply(): void {
        if (canonKey === null || !entry) {
            batch(() => {
                state.st = 'idle';
                state.data = null;
                state.err = null;
            });
            return;
        }
        const e = entry;
        const inflight = e.promise !== null;
        batch(() => {
            if (inflight) {
                const shown = e.hasValue ? (e.value as T) : keepPreviousData ? previousData : null;
                state.st = shown !== null ? 'refreshing' : 'pending';
                state.data = shown;
                state.err = null;
            } else if (e.error) {
                if (e.hasValue) staleVal = e.value as T;
                state.st = 'errored';
                state.data = null;
                state.err = e.error;
            } else if (e.hasValue) {
                staleVal = e.value as T;
                state.st = 'ready';
                state.data = e.value as T;
                state.err = null;
            } else {
                state.st = 'pending';
                state.data = keepPreviousData ? previousData : null;
                state.err = null;
            }
        });
    }

    const subscriber: EntrySubscriber = { onEntry: () => untrack(apply) };

    function setKey(canon: string | null, raw: unknown): void {
        untrack(() => {
            if (canon === canonKey) {
                // Same canonical identity — keep the freshest raw object on
                // both sides so later refetches (focus/interval/invalidate)
                // use it.
                rawArg = raw;
                if (entry) entry.rawArg = raw;
                return;
            }
            // Leaving the old key: remember its value for keepPreviousData.
            previousData = state.data;
            if (canonKey !== null) store.unsubscribe(canonKey, subscriber);
            canonKey = canon;
            rawArg = raw;
            staleVal = null;

            if (canon === null || disposed) {
                entry = null;
                apply();
                return;
            }

            entry = store.subscribe(canon, subscriber, policy);
            entry.fetcher = fetcher;
            entry.rawArg = raw;

            if (!store.isFresh(entry, staleTime) && isLiveClient()) {
                // Stale (or empty): revalidate. apply() below renders the
                // cached value as 'refreshing' while it runs, or 'pending'
                // when there is nothing to show.
                void store.fetch(canon, fetcher, raw);
            }
            apply();
        });
    }

    function refresh(): Promise<void> {
        if (canonKey === null) return Promise.resolve();
        return store.fetch(canonKey, fetcher, rawArg, true);
    }

    const cell: CachedAsyncState<T> = {
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
                    stale: staleVal,
                    retry: () => void refresh(),
                    onUnhandledError: reportUnhandled,
                },
                arms
            );
        },
        refresh,
        invalidate() {
            if (canonKey !== null) store.invalidate(canonKey);
        },
        mutate(update) {
            if (canonKey === null) return;
            const current = (entry && entry.hasValue ? entry.value : null) as T | null;
            const next = typeof update === 'function' ? (update as (c: T | null) => T)(current) : update;
            store.write(canonKey, next);
        },
    };

    return {
        state: cell,
        setKey,
        dispose() {
            disposed = true;
            if (canonKey !== null) store.unsubscribe(canonKey, subscriber);
            canonKey = null;
            entry = null;
        },
    };
}

/** Snapshot for optimistic rollback. */
function snapshotOf(store: CacheStore, canon: string): { hasValue: boolean; value: unknown; updatedAt: number } {
    const e = store.peek(canon);
    return e && e.hasValue
        ? { hasValue: true, value: e.value, updatedAt: e.updatedAt }
        : { hasValue: false, value: undefined, updatedAt: 0 };
}

function canonOf(key: string | readonly unknown[]): string {
    return typeof key === 'string' ? key : JSON.stringify(key);
}

export function createCacheEngine(store: CacheStore): AsyncEngine {
    return {
        read<T>(fetcher: Fetcher, options: object, instance: Parameters<AsyncEngine['read']>[2]): AsyncReadHandle<T> {
            const cache = (options as { cache?: CacheOptions }).cache;
            if (!cache) {
                // No cache policy — core's default engine verbatim, plus the
                // convenience invalidate() (≡ refresh: drop + refetch).
                const handle = defaultAsyncEngine.read<T>(fetcher as (arg: unknown, ctx: AsyncFetcherContext) => Promise<T>, options, instance);
                (handle.state as Partial<CachedAsyncState<T>>).invalidate = () => void handle.state.refresh();
                return handle;
            }
            return createCachedRead<T>(store, fetcher, cache, instance);
        },

        wrapAction<A>(action: A, options: object, _instance: Parameters<AsyncEngine['read']>[2]): A {
            const cache = (options as { cache?: CacheActionOptions }).cache;
            if (!cache) return action;

            const inner = action as unknown as {
                run(input: unknown): Promise<{ ok: boolean; error?: Error }>;
            };
            const innerRun = inner.run.bind(inner);

            inner.run = async (input: unknown) => {
                let optimisticKey: string | null = null;
                let snapshot: ReturnType<typeof snapshotOf> | null = null;
                let writeSeq = 0;

                if (cache.optimistic) {
                    optimisticKey = canonOf(cache.optimistic.key);
                    snapshot = snapshotOf(store, optimisticKey);
                    const current = snapshot.hasValue ? snapshot.value : null;
                    writeSeq = store.write(optimisticKey, cache.optimistic.apply(current, input));
                }

                const result = await innerRun(input);

                if (result.ok) {
                    for (const pattern of cache.invalidates ?? []) {
                        store.invalidate(pattern);
                    }
                    // The optimistic value stands until the invalidation
                    // refetch (if any) confirms it — write-through semantics.
                } else if (optimisticKey !== null && snapshot) {
                    // Rollback — unless something newer wrote after us (a
                    // newer optimistic run supersedes this one's rollback).
                    store.rollback(optimisticKey, snapshot, writeSeq);
                }
                return result;
            };

            return action;
        },
    };
}
