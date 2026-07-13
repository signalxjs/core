/**
 * The pack's option surfaces — attached to core's OPEN AsyncOptions /
 * ActionOptions interfaces via module augmentation (see index.ts): the
 * `cache` key exists at call sites exactly when this pack is installed
 * (rfc-async §7, obligation 2).
 */

/** Per-read cache policy: `useData(key, fn, { cache: { … } })`. */
export interface CacheOptions {
    /**
     * How long a cached value counts as FRESH (ms). A fresh value is served
     * without fetching; a stale one is served immediately and revalidated in
     * the background (state 'refreshing'). Default: the plugin default (0 —
     * always revalidate on mount).
     */
    staleTime?: number;
    /**
     * Retention after the last consumer unmounts (ms). Default: the plugin
     * default (5 minutes). 0 drops the entry immediately.
     */
    gcTime?: number;
    /** Revalidate mounted reads when the window regains focus/visibility. */
    revalidateOnFocus?: boolean;
    /** Revalidate mounted reads every N ms. */
    revalidateOnInterval?: number;
    /**
     * Across a KEY CHANGE with nothing cached for the new key, keep showing
     * the previous key's value (state 'refreshing') instead of core's hard
     * reset to 'pending'. Softens pagination/search flows.
     */
    keepPreviousData?: boolean;
}

/** Per-action cache policy: `useAction(fn, { cache: { … } })`. */
export interface CacheActionOptions {
    /**
     * Keys (or tuple PREFIXES — `['posts']` matches every `['posts', …]`
     * read) invalidated after a successful run: dropped from freshness and
     * refetched for every mounted consumer.
     */
    invalidates?: readonly (string | readonly unknown[])[];
    /**
     * Optimistic write-through: before the request runs, `apply(current,
     * input)` is written to `key` (every mounted consumer re-renders); a
     * failed run rolls the entry back — unless something newer wrote to it
     * meanwhile.
     */
    optimistic?: {
        key: string | readonly unknown[];
        apply: (current: any, input: any) => any;
    };
}

/** App-wide defaults, passed to `cachePlugin({ … })`. */
export interface CacheDefaults {
    staleTime?: number;
    gcTime?: number;
}
