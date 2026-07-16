/**
 * Serialized-state pickup — the ONLY module that touches the page blob
 * (`window.__SIGX_ASYNC__`, emitted by the server renderer).
 *
 * The blob is the page's DATA CACHE for its lifetime: every mount of the
 * same key restores from it (two components sharing a key both restore —
 * neither refetches), including remounts after client-side navigation.
 * Successful keyed fetches write back, so the cache always holds the
 * latest value regardless of whether SSR seeded the key. `refresh()`
 * invalidates the entry, fetches fresh, and repopulates on success.
 *
 * Every function is guarded behind `typeof window` — runtime-core must
 * reference no web global unguarded (embedded/server runtimes). These
 * guards deliberately stay `typeof window` (NOT `isLiveClient()`): the
 * blob is an HTML-page transport, so on windowless live clients (lynx,
 * terminal) pickup correctly misses and writeback correctly no-ops.
 */

const MISS = { hit: false, value: undefined } as const;

/** Read a server-serialized value for `key` from the page blob. */
export function peekRestored(key: string): { hit: boolean; value: unknown } {
    if (typeof window === 'undefined') return MISS;
    const blob = (globalThis as any).__SIGX_ASYNC__;
    // Own-property check: `in` would also see inherited keys (and misbehave
    // on keys like "__proto__"/"constructor").
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        return { hit: true, value: blob[key] };
    }
    return MISS;
}

/** Invalidate a restored entry — called before fetching fresh data. */
export function invalidateRestored(key: string): void {
    if (typeof window === 'undefined') return;
    const blob = (globalThis as any).__SIGX_ASYNC__;
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        delete blob[key];
    }
}

/**
 * Write a successful keyed fetch back into the page cache so later mounts
 * restore the LATEST value — identical behavior whether or not SSR seeded
 * the key. (Null-prototype blob — see the server emitter.)
 */
export function writeBack(key: string, value: unknown): void {
    if (typeof window === 'undefined') return;
    const blob = ((globalThis as any).__SIGX_ASYNC__ ??= Object.create(null));
    blob[key] = value;
}
