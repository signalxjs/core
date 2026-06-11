/**
 * useAsync / useStream — THE async-data primitives.
 *
 * One rule: give it a KEY and it becomes server-transferable.
 *
 *   useAsync(fn)            → unkeyed: client-only async work
 *   useAsync(key, fn, opts) → keyed: runs on the server, value serialized
 *                             under the key, restored on hydration, deduped
 *                             per key within a request/page
 *   useStream(key, source)  → progressive text (LLM-token-style): streams
 *                             on the server, restored on hydration, live on
 *                             client navigation
 *
 * This module provides the default CLIENT semantics. Server renderers
 * install per-instance providers (`_useAsync` / `_useStream` on the setup
 * context) that take over during SSR — same pattern as the `ssr` helper.
 *
 * Design doc: docs/rfc-use-async.md.
 */

import { signal, batch } from '@sigx/reactivity';
import { getCurrentInstance } from './component-lifecycle.js';

export interface AsyncFetcherContext {
    /**
     * Aborted when the component unmounts or a refresh() supersedes this
     * run. Pass it straight to fetch():  fetch(url, { signal })
     */
    signal: AbortSignal;
}

export interface AsyncOptions {
    /**
     * Throw fetch errors when `.error` is read during render instead of
     * exposing them — routes to the nearest error boundary / component
     * error fallback. Default: false.
     */
    throwOnError?: boolean;

    /**
     * (Keyed form.) Run the fetcher on the server. Default: true.
     * `server: false` renders the loading branch during SSR and fetches on
     * the client after hydration.
     */
    server?: boolean;
}

/**
 * Reactive async state. Reading `value` / `loading` / `error` inside a
 * render function subscribes it — the component re-renders on change.
 */
export interface AsyncState<T> {
    /** The resolved data; null while loading or after an error. */
    readonly value: T | null;
    /** True while the fetcher is in flight. */
    readonly loading: boolean;
    /** The fetch error, or null. */
    readonly error: Error | null;
    /** Re-run the fetcher (client; no-op during SSR). Aborts an in-flight run. */
    refresh(): Promise<void>;
}

// ============= Serialized-state pickup =============

/**
 * Read a server-serialized value for `key` from the page blob
 * (`window.__SIGX_ASYNC__`, emitted by the server renderer).
 *
 * The blob is the page's INITIAL-DATA CACHE for its lifetime: every mount
 * of the same key restores from it (two components sharing a key both
 * restore — neither refetches), including remounts after client-side
 * navigation. `refresh()` is the explicit invalidation: it deletes the
 * key's entry and fetches fresh data.
 */
function peekRestored(key: string): { hit: boolean; value: unknown } {
    const blob = (globalThis as any).__SIGX_ASYNC__;
    // Own-property check: `in` would also see inherited keys (and misbehave
    // on keys like "__proto__"/"constructor").
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        return { hit: true, value: blob[key] };
    }
    return { hit: false, value: undefined };
}

/** Invalidate a restored entry — called by run()/refresh() before fetching. */
function invalidateRestored(key: string): void {
    const blob = (globalThis as any).__SIGX_ASYNC__;
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        delete blob[key];
    }
}

/** In-flight dedupe for keyed client fetches (concurrent mounts share one run). */
const inflight = new Map<string, Promise<unknown>>();

// ============= useAsync =============

/** Unkeyed: client-only async work. The fetcher never runs on the server. */
export function useAsync<T>(
    fetcher: (ctx: AsyncFetcherContext) => Promise<T>,
    options?: AsyncOptions
): AsyncState<T>;
/** Keyed: runs on the server, serialized under `key`, restored on hydration. */
export function useAsync<T>(
    key: string,
    fetcher: (ctx: AsyncFetcherContext) => Promise<T>,
    options?: AsyncOptions
): AsyncState<T>;
export function useAsync<T>(
    keyOrFetcher: string | ((ctx: AsyncFetcherContext) => Promise<T>),
    fetcherOrOptions?: ((ctx: AsyncFetcherContext) => Promise<T>) | AsyncOptions,
    maybeOptions?: AsyncOptions
): AsyncState<T> {
    const keyed = typeof keyOrFetcher === 'string';
    const key = keyed ? (keyOrFetcher as string) : null;
    const fetcher = (keyed ? fetcherOrOptions : keyOrFetcher) as (ctx: AsyncFetcherContext) => Promise<T>;
    const options = (keyed ? maybeOptions : fetcherOrOptions as AsyncOptions | undefined) ?? {};

    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useAsync() must be called synchronously during component setup.');
    }

    // Environment provider (server render) takes over
    if ((instance as any)._useAsync) {
        return (instance as any)._useAsync(key, fetcher, options) as AsyncState<T>;
    }

    // ── Default client semantics ──
    const restored = key !== null ? peekRestored(key) : { hit: false, value: undefined };

    const state = signal({
        data: (restored.hit ? restored.value : null) as T | null,
        pending: !restored.hit,
        failure: null as Error | null
    });

    let controller: AbortController | null = null;

    async function run(): Promise<void> {
        controller?.abort();
        controller = new AbortController();
        const { signal: abortSignal } = controller;

        // Fetching means the restored value (if any) is no longer the truth —
        // invalidate so later mounts fetch instead of restoring stale data.
        if (key !== null) invalidateRestored(key);

        batch(() => {
            state.pending = true;
            state.failure = null;
        });

        try {
            let promise = key !== null ? (inflight.get(key) as Promise<T> | undefined) : undefined;
            if (!promise) {
                promise = fetcher({ signal: abortSignal });
                if (key !== null) {
                    const k = key;
                    inflight.set(k, promise);
                    void promise.catch(() => { }).then(() => inflight.delete(k));
                }
            }
            const result = await promise;
            if (abortSignal.aborted) return;
            batch(() => {
                state.data = result;
                state.pending = false;
            });
        } catch (e) {
            if (abortSignal.aborted) return;
            batch(() => {
                state.failure = e instanceof Error ? e : new Error(String(e));
                state.pending = false;
            });
        }
    }

    instance.onUnmounted(() => controller?.abort());

    // SSR without a provider should never happen (the server walk installs
    // one), but guard anyway: never run fetchers outside a browser here.
    if (!restored.hit && typeof window !== 'undefined') {
        void run();
    }

    return {
        get value() { return state.data; },
        get loading() { return state.pending; },
        get error() {
            if (options.throwOnError && state.failure) throw state.failure;
            return state.failure;
        },
        refresh: run
    };
}

// ============= useStream =============

/**
 * Progressive text (LLM-token-style). Returns a string signal that
 * accumulates the source's chunks.
 *
 * - Server, streaming: tokens append into the page as they arrive; the
 *   final text swaps in and is serialized under `key`.
 * - Server, blocking: drained fully, final text inline.
 * - Client, hydrating: final text restored from `key` — the source is NOT
 *   re-run (no duplicate LLM calls).
 * - Client, navigation: runs live; the signal updates per chunk.
 */
export function useStream(
    key: string,
    source: () => AsyncIterable<string>
): { readonly value: string } {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useStream() must be called synchronously during component setup.');
    }

    if ((instance as any)._useStream) {
        return (instance as any)._useStream(key, source);
    }

    // ── Default client semantics ──
    const restored = peekRestored(key);
    const text = signal(restored.hit ? String(restored.value) : '');

    if (!restored.hit && typeof window !== 'undefined') {
        void (async () => {
            let acc = '';
            for await (const token of source()) {
                acc += token;
                text.value = acc;
            }
        })().catch(err => console.error('[useStream] source error:', err));
    }

    return text;
}
