/**
 * The cache store — one per app (created by cachePlugin's install).
 *
 * Entries are keyed by the same canonical identity core uses (plain string
 * keys; tuple keys as canonical JSON), so the store adopts the page's
 * `__SIGX_ASYNC__` hydration blob as its initial state (rfc-async §7,
 * blob-as-seed) and stays interchangeable with core's default engine.
 */

import type { AsyncFetcherContext } from '@sigx/runtime-core';
import { normalizeError, makeAbortController, inertAbortSignal } from '@sigx/runtime-core/internals';
import type { CacheDefaults } from './options.js';

/** Store-side view of one mounted cell — notified when its entry changes. */
export interface EntrySubscriber {
    onEntry(): void;
}

export interface CacheEntry {
    key: string;
    /** `hasValue` disambiguates "no value yet" from a legitimate null value. */
    hasValue: boolean;
    value: unknown;
    error: Error | null;
    /** Epoch ms of the last successful write (fetch, mutate, seed). */
    updatedAt: number;
    /** In-flight dedupe: one fetch per key at a time. */
    promise: Promise<unknown> | null;
    /** Bumped on every value write — optimistic rollbacks are conditional on it. */
    writeSeq: number;
    /** Last known fetcher + raw key arg — used by invalidate()/revalidation. */
    fetcher: ((arg: unknown, ctx: AsyncFetcherContext) => Promise<unknown>) | null;
    rawArg: unknown;
    /** Per-entry policy (merged option defaults of the mounted cells). */
    gcTime: number;
    revalidateOnFocus: boolean;
    revalidateOnInterval: number | undefined;
    subscribers: Set<EntrySubscriber>;
    gcTimer: ReturnType<typeof setTimeout> | null;
    intervalTimer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_GC_TIME = 5 * 60_000;

/**
 * The default attention trigger: window focus + visibilitychange. Installed
 * only when a DOM is present — non-web runtimes pass their own trigger via
 * `cachePlugin({ revalidateTrigger })` (app resume, terminal focus, …).
 */
function domAttentionTrigger(revalidate: () => void): (() => void) | void {
    if (typeof window === 'undefined') return;
    const listener = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        revalidate();
    };
    window.addEventListener('focus', listener);
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', listener);
    }
    return () => {
        window.removeEventListener('focus', listener);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', listener);
        }
    };
}

/** Read the page blob without consuming it (the store seeds from it once per key). */
function peekBlob(key: string): { hit: boolean; value: unknown } {
    if (typeof window === 'undefined') return { hit: false, value: undefined };
    const blob = (globalThis as any).__SIGX_ASYNC__;
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        return { hit: true, value: blob[key] };
    }
    return { hit: false, value: undefined };
}

/** Keep the blob in sync on successful writes — later default-engine mounts restore the latest value. */
function writeBlob(key: string, value: unknown): void {
    if (typeof window === 'undefined') return;
    const blob = ((globalThis as any).__SIGX_ASYNC__ ??= Object.create(null));
    blob[key] = value;
}

/**
 * Canonical-key pattern match for invalidate(): exact string equality, or —
 * when the pattern is a tuple prefix — every entry whose canonical tuple
 * starts with those elements (`['posts']` matches `'["posts","u1",2]'`).
 */
export function keyMatches(entryKey: string, pattern: string | readonly unknown[]): boolean {
    if (typeof pattern === 'string') return entryKey === pattern;
    const canon = JSON.stringify(pattern); // '["posts","u1"]'
    if (entryKey === canon) return true;
    const prefix = canon.slice(0, -1); // '["posts","u1"'
    return entryKey.startsWith(prefix) && (entryKey[prefix.length] === ',' || entryKey[prefix.length] === ']');
}

export class CacheStore {
    private entries = new Map<string, CacheEntry>();
    /** Blob adoption is INITIAL state (§7): each key seeds at most once per store lifetime. */
    private seeded = new Set<string>();
    private triggerInstalled = false;
    private triggerUnsub: (() => void) | null = null;
    private readonly revalidateTrigger: (revalidate: () => void) => (() => void) | void;
    readonly defaultStaleTime: number;
    readonly defaultGcTime: number;

    constructor(defaults: CacheDefaults = {}) {
        this.defaultStaleTime = defaults.staleTime ?? 0;
        this.defaultGcTime = defaults.gcTime ?? DEFAULT_GC_TIME;
        this.revalidateTrigger = defaults.revalidateTrigger ?? domAttentionTrigger;
    }

    ensure(key: string): CacheEntry {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                key,
                hasValue: false,
                value: undefined,
                error: null,
                updatedAt: 0,
                promise: null,
                writeSeq: 0,
                fetcher: null,
                rawArg: undefined,
                gcTime: this.defaultGcTime,
                revalidateOnFocus: false,
                revalidateOnInterval: undefined,
                subscribers: new Set(),
                gcTimer: null,
                intervalTimer: null,
            };
            // Blob-as-seed (§7): the hydration cache is the INITIAL state —
            // a key seeds once; after gc the store is the source of truth
            // (otherwise our own write-through would resurrect gc'd entries
            // as fresh forever).
            if (!this.seeded.has(key)) {
                this.seeded.add(key);
                const seed = peekBlob(key);
                if (seed.hit) {
                    entry.hasValue = true;
                    entry.value = seed.value;
                    entry.updatedAt = Date.now();
                }
            }
            this.entries.set(key, entry);
        }
        return entry;
    }

    peek(key: string): CacheEntry | undefined {
        return this.entries.get(key);
    }

    isFresh(entry: CacheEntry, staleTime: number): boolean {
        return entry.hasValue && Date.now() - entry.updatedAt < staleTime;
    }

    subscribe(
        key: string,
        sub: EntrySubscriber,
        policy: { gcTime: number; revalidateOnFocus: boolean; revalidateOnInterval?: number }
    ): CacheEntry {
        const entry = this.ensure(key);
        const isFirst = entry.subscribers.size === 0 && entry.gcTimer === null;
        entry.subscribers.add(sub);
        if (entry.gcTimer) {
            clearTimeout(entry.gcTimer);
            entry.gcTimer = null;
        }
        // The first consumer SETS the retention policy; later concurrent
        // consumers merge — longest retention, any-focus wins, shortest
        // interval wins.
        entry.gcTime = isFirst ? policy.gcTime : Math.max(entry.gcTime, policy.gcTime);
        if (policy.revalidateOnFocus) {
            entry.revalidateOnFocus = true;
            this.ensureRevalidateTrigger();
        }
        if (policy.revalidateOnInterval !== undefined) {
            entry.revalidateOnInterval =
                entry.revalidateOnInterval === undefined
                    ? policy.revalidateOnInterval
                    : Math.min(entry.revalidateOnInterval, policy.revalidateOnInterval);
            this.ensureIntervalTimer(entry);
        }
        return entry;
    }

    unsubscribe(key: string, sub: EntrySubscriber): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        entry.subscribers.delete(sub);
        if (entry.subscribers.size === 0) {
            if (entry.intervalTimer) {
                clearInterval(entry.intervalTimer);
                entry.intervalTimer = null;
            }
            // Retention window, then drop (0 ⇒ immediate).
            const drop = () => {
                const current = this.entries.get(key);
                if (current === entry && entry.subscribers.size === 0) {
                    this.entries.delete(key);
                }
            };
            if (entry.gcTime <= 0) {
                drop();
            } else {
                entry.gcTimer = setTimeout(drop, entry.gcTime);
            }
        }
    }

    private notify(entry: CacheEntry): void {
        for (const sub of entry.subscribers) sub.onEntry();
    }

    /**
     * Fetch (or join the in-flight fetch) for a key. Settles the entry and
     * notifies subscribers; never rejects.
     */
    fetch(
        key: string,
        fetcher: (arg: unknown, ctx: AsyncFetcherContext) => Promise<unknown>,
        rawArg: unknown,
        force = false
    ): Promise<void> {
        const entry = this.ensure(key);
        entry.fetcher = fetcher;
        entry.rawArg = rawArg;

        if (entry.promise && !force) {
            return entry.promise.then(
                () => undefined,
                () => undefined
            );
        }

        const ctrl = makeAbortController();
        const ctx: AsyncFetcherContext = { signal: ctrl ? ctrl.signal : inertAbortSignal() };
        let p: Promise<unknown>;
        try {
            p = Promise.resolve(fetcher(rawArg, ctx));
        } catch (e) {
            p = Promise.reject(e);
        }
        entry.promise = p;
        // Fetch-start notification (other consumers flip to 'refreshing').
        // Deferred out of the current frame: fetches can start during a
        // descendant's setup, inside an ancestor's render effect — whose
        // re-entrant notifications the reactivity system drops by design.
        queueMicrotask(() => {
            if (entry.promise === p) this.notify(entry);
        });

        return p.then(
            (value) => {
                if (entry.promise !== p) return; // superseded by a forced refetch
                entry.promise = null;
                this.write(key, value);
            },
            (e) => {
                if (entry.promise !== p) return;
                entry.promise = null;
                entry.error = normalizeError(e);
                // A failed revalidate keeps the last-good value (SWR) — only
                // the error field changes; cells decide how to render it.
                this.notify(entry);
            }
        );
    }

    /** Direct value write (fetch success, optimistic apply, mutate). */
    write(key: string, value: unknown): number {
        const entry = this.ensure(key);
        entry.hasValue = true;
        entry.value = value;
        entry.error = null;
        entry.updatedAt = Date.now();
        entry.writeSeq++;
        writeBlob(key, value);
        this.notify(entry);
        return entry.writeSeq;
    }

    /** Conditional rollback for optimistic writes: only when nothing wrote after us. */
    rollback(key: string, snapshot: { hasValue: boolean; value: unknown; updatedAt: number }, ifSeq: number): void {
        const entry = this.entries.get(key);
        if (!entry || entry.writeSeq !== ifSeq) return;
        entry.hasValue = snapshot.hasValue;
        entry.value = snapshot.value;
        entry.updatedAt = snapshot.updatedAt;
        entry.writeSeq++;
        if (snapshot.hasValue) writeBlob(key, snapshot.value);
        this.notify(entry);
    }

    /**
     * Mark entries matching the pattern stale and refetch the mounted ones
     * (entries with live subscribers and a known fetcher).
     */
    invalidate(pattern: string | readonly unknown[]): void {
        for (const entry of this.entries.values()) {
            if (!keyMatches(entry.key, pattern)) continue;
            entry.updatedAt = 0; // stale for every future staleTime check
            if (typeof window !== 'undefined') {
                const blob = (globalThis as any).__SIGX_ASYNC__;
                if (blob && Object.prototype.hasOwnProperty.call(blob, entry.key)) delete blob[entry.key];
            }
            if (entry.subscribers.size > 0 && entry.fetcher) {
                void this.fetch(entry.key, entry.fetcher, entry.rawArg, true);
            }
        }
    }

    /**
     * Attention revalidation — the trigger subscribes ONE "revalidate now"
     * callback per store, lazily on the first read that opts in. The event
     * source is the platform's: DOM focus/visibility by default, whatever
     * `cachePlugin({ revalidateTrigger })` provided otherwise.
     */
    private ensureRevalidateTrigger(): void {
        if (this.triggerInstalled) return;
        this.triggerInstalled = true;
        try {
            this.triggerUnsub =
                this.revalidateTrigger(() => {
                    for (const entry of this.entries.values()) {
                        if (!entry.revalidateOnFocus || entry.subscribers.size === 0 || !entry.fetcher) continue;
                        void this.fetch(entry.key, entry.fetcher, entry.rawArg, true);
                    }
                }) ?? null;
        } catch (e) {
            // A broken trigger must not crash the mounting read. Surface it
            // and clear the flag so a later opting-in read can retry.
            this.triggerInstalled = false;
            // Prod ships the bare code + docs pointer; the full message is
            // dev-only (the __DEV__ branch folds away in the prod dist).
            console.error(
                __DEV__
                    ? '[sigx-cache] revalidateTrigger threw while subscribing:'
                    : 'SIGX700 — see https://sigx.dev/errors/SIGX700/',
                e
            );
        }
    }

    private ensureIntervalTimer(entry: CacheEntry): void {
        if (typeof window === 'undefined' || entry.revalidateOnInterval === undefined) return;
        if (entry.intervalTimer) clearInterval(entry.intervalTimer);
        entry.intervalTimer = setInterval(() => {
            if (entry.subscribers.size === 0 || !entry.fetcher) return;
            void this.fetch(entry.key, entry.fetcher, entry.rawArg, true);
        }, entry.revalidateOnInterval);
    }

    /** App teardown: clear every timer and unsubscribe the attention trigger. */
    destroy(): void {
        for (const entry of this.entries.values()) {
            if (entry.gcTimer) clearTimeout(entry.gcTimer);
            if (entry.intervalTimer) clearInterval(entry.intervalTimer);
        }
        this.entries.clear();
        if (this.triggerUnsub) {
            this.triggerUnsub();
            this.triggerUnsub = null;
        }
        this.triggerInstalled = false;
    }
}
