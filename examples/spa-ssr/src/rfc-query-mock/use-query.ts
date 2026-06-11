/**
 * ════════════════════════════════════════════════════════════════════════
 *  DESIGN MOCK — `useQuery` (docs/rfc-query.md). NOT implemented in sigx.
 *
 *  This file exists so the RFC can be inspected in an editor with real
 *  types: hover the examples in ./examples.tsx to see inference at work.
 *  The mock implements the CLIENT semantics faithfully; the server and
 *  hydration behaviors are marked where the real implementation plugs in
 *  (runtime-core provides this default, server-renderer swaps it per
 *  environment — same pattern as ctx.ssr today).
 * ════════════════════════════════════════════════════════════════════════
 */

import { signal, getCurrentInstance } from 'sigx';

export interface QueryFetcherContext {
    /**
     * Aborted when the component unmounts or a refresh() supersedes this
     * run. Pass it straight to fetch():  fetch(url, { signal })
     */
    signal: AbortSignal;
}

export interface QueryOptions {
    /**
     * Throw fetch errors during render instead of exposing them on
     * `.error` — routes to the nearest error boundary. Default: false.
     */
    throwOnError?: boolean;

    /**
     * Run the fetcher on the server. Default: true.
     * `server: false` = client-only query: SSR renders the loading branch,
     * the client fetches after hydration. This replaces useAsync (and is
     * the right mode for browser-dependent resources).
     */
    server?: boolean;
}

/**
 * A reactive resource. Reading `.value` / `.loading` / `.error` inside a
 * render function subscribes it — the component re-renders on change.
 */
export interface Resource<T> {
    /** The resolved data, or undefined while loading / after an error. */
    readonly value: T | undefined;
    /** True while a fetch is in flight. */
    readonly loading: boolean;
    /** The fetch error, or null. */
    readonly error: Error | null;
    /** Re-run the fetcher (client). Aborts an in-flight run. */
    refresh(): Promise<void>;
}

/**
 * In-flight dedupe, request-global on the server (SSRContext._queryCache),
 * page-scoped on the client. Two components querying the same key share
 * ONE fetch and one serialized entry. Keys identify the DATA, not the
 * component — include identity in the key: `user:${id}`.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Declare an async data dependency. Must be called synchronously during
 * component setup (like every composable).
 *
 * | Environment              | Behavior                                        |
 * |--------------------------|-------------------------------------------------|
 * | server, blocking/string  | awaited inline; value serialized under `key`     |
 * | server, streaming        | loading branch in placeholder → replaced         |
 * | hydration, state present | restored — fetcher NOT run                       |
 * | hydration, state absent  | refetches (fail-safe)                            |
 * | client navigation        | fetches; loading/error reactive; abort on unmount|
 */
export function useQuery<T>(
    key: string,
    fetcher: (ctx: QueryFetcherContext) => Promise<T>,
    options: QueryOptions = {}
): Resource<T> {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useQuery() must be called synchronously during component setup.');
    }

    // ── Hydration restore ─────────────────────────────────────────────
    // The server serialized resolved values under their explicit keys:
    //   <script>window.__SIGX_QUERY__ = { "stats": {...}, "user:1": {...} }</script>
    const restoredBlob = typeof window !== 'undefined'
        ? (window as { __SIGX_QUERY__?: Record<string, unknown> }).__SIGX_QUERY__
        : undefined;
    const restored = restoredBlob && key in restoredBlob
        ? (restoredBlob[key] as T)
        : undefined;

    const state = signal({
        data: restored,
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
            // Dedupe: join an identical in-flight fetch instead of refetching
            let promise = inflight.get(key) as Promise<T> | undefined;
            if (!promise) {
                promise = fetcher({ signal: abortSignal });
                inflight.set(key, promise);
                void promise.finally(() => inflight.delete(key));
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
    // REAL IMPL — server walk: registers through the ssr.load machinery
    // (block mode awaits inline, streaming mode placeholder+replace) and
    // records the resolved value for the __SIGX_QUERY__ blob.
    // MOCK — client semantics only:
    const isServer = typeof window === 'undefined';
    if (restored === undefined && !(isServer && options.server === false)) {
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
