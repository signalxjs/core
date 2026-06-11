/**
 * ════════════════════════════════════════════════════════════════════════
 *  DESIGN MOCK — `useAsync` (docs/rfc-use-async.md). NOT implemented yet.
 *
 *  This file exists so the RFC can be inspected in an editor with real
 *  types: hover the examples in ./examples.tsx to see inference at work.
 *  The mock implements the CLIENT semantics faithfully; the server and
 *  hydration behaviors are marked where the real implementation plugs in.
 *
 *  Design rule: "give it a KEY and it becomes server-transferable."
 *
 *    useAsync(fn)            → unkeyed: client-only (today's useAsync, fixed)
 *    useAsync(key, fn, opts) → keyed: runs on the server, value serialized
 *                              under the key, restored on hydration
 *
 *  This is an UPGRADE of the existing runtime-core useAsync, not a new
 *  API: existing `useAsync(fn)` call sites keep compiling and working.
 *  The return type is the existing AsyncState<T>, extended with refresh().
 * ════════════════════════════════════════════════════════════════════════
 */

import { signal, getCurrentInstance } from 'sigx';

export interface AsyncFetcherContext {
    /**
     * Aborted when the component unmounts or a refresh() supersedes this
     * run. Pass it straight to fetch():  fetch(url, { signal })
     */
    signal: AbortSignal;
}

export interface AsyncOptions {
    /**
     * Throw fetch errors during render instead of exposing them on
     * `.error` — routes to the nearest error boundary. Default: false.
     */
    throwOnError?: boolean;

    /**
     * (Keyed form only.) Run the fetcher on the server. Default: true.
     * `server: false` keeps the key for client-side dedupe but renders
     * the loading branch during SSR.
     */
    server?: boolean;
}

/**
 * The existing runtime-core AsyncState<T>, extended with refresh().
 * Reading `.value` / `.loading` / `.error` inside a render function
 * subscribes it — the component re-renders on change.
 */
export interface AsyncState<T> {
    /** The resolved data; null while loading or after an error. */
    readonly value: T | null;
    /** True while a fetch is in flight. */
    readonly loading: boolean;
    /** The fetch error, or null. */
    readonly error: Error | null;
    /** Re-run the fetcher (client). Aborts an in-flight run. */
    refresh(): Promise<void>;
}

/**
 * In-flight dedupe for KEYED calls — request-global on the server
 * (SSRContext), page-scoped on the client. Two components using the same
 * key share ONE fetch and one serialized entry. Keys identify the DATA,
 * not the component: include identity in the key (`user:${id}`).
 */
const inflight = new Map<string, Promise<unknown>>();

/** Unkeyed: client-only async work (today's useAsync semantics, leak fixed). */
export function useAsync<T>(
    fetcher: (ctx: AsyncFetcherContext) => Promise<T>
): AsyncState<T>;
/** Keyed: runs on the server, serialized under `key`, restored on hydration. */
export function useAsync<T>(
    key: string,
    fetcher: (ctx: AsyncFetcherContext) => Promise<T>,
    options?: AsyncOptions
): AsyncState<T>;
export function useAsync<T>(
    keyOrFetcher: string | ((ctx: AsyncFetcherContext) => Promise<T>),
    maybeFetcher?: (ctx: AsyncFetcherContext) => Promise<T>,
    options: AsyncOptions = {}
): AsyncState<T> {
    const key = typeof keyOrFetcher === 'string' ? keyOrFetcher : null;
    const fetcher = typeof keyOrFetcher === 'string' ? maybeFetcher! : keyOrFetcher;

    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useAsync() must be called synchronously during component setup.');
    }

    // ── Hydration restore (keyed only) ────────────────────────────────
    // The server serialized resolved values under their explicit keys:
    //   <script>window.__SIGX_ASYNC__ = { "stats": {...}, "user:1": {...} }</script>
    const restoredBlob = key !== null && typeof window !== 'undefined'
        ? (window as { __SIGX_ASYNC__?: Record<string, unknown> }).__SIGX_ASYNC__
        : undefined;
    const restored = restoredBlob && key !== null && key in restoredBlob
        ? (restoredBlob[key] as T)
        : undefined;

    const state = signal({
        data: restored !== undefined ? restored : null as T | null,
        pending: restored === undefined,
        failure: null as Error | null
    });

    let controller: AbortController | null = null;

    async function run(): Promise<void> {
        controller?.abort();
        controller = new AbortController();
        const { signal: abortSignal } = controller;

        state.pending = true;
        state.failure = null;

        try {
            // Keyed calls dedupe: join an identical in-flight fetch
            let promise = key !== null ? inflight.get(key) as Promise<T> | undefined : undefined;
            if (!promise) {
                promise = fetcher({ signal: abortSignal });
                if (key !== null) {
                    inflight.set(key, promise);
                    void promise.finally(() => inflight.delete(key));
                }
            }
            const result = await promise;
            if (abortSignal.aborted) return;
            state.data = result;
            state.pending = false;
        } catch (e) {
            if (abortSignal.aborted) return;
            state.failure = e instanceof Error ? e : new Error(String(e));
            state.pending = false;
        }
    }

    // Abort in-flight work when the component unmounts
    instance.onUnmounted(() => controller?.abort());

    // ── Environment dispatch ──────────────────────────────────────────
    // REAL IMPL — server walk for KEYED calls: registers through the
    // ssr.load machinery (block mode awaits inline, streaming mode
    // placeholder+replace) and records the resolved value for the
    // __SIGX_ASYNC__ blob. Unkeyed (and { server: false }) calls never
    // run on the server — the loading branch renders into the HTML.
    // MOCK — client semantics only:
    const isServer = typeof window === 'undefined';
    if (restored === undefined && !isServer) {
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
