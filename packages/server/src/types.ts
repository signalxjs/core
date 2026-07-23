/**
 * Shared server-function types — split from index.ts so the WinterCG request
 * handler (`./server`) can import them without pulling the marker module in.
 */
import type { ServerFnContext, ServerFnContextInit } from './context';

/** Identity of the function being invoked, as the transports know it. */
export interface ServerFnInfo {
    /**
     * The content-hashed transport symbol (`<name>_fn_<hash8>`). Empty on
     * in-process calls — the symbol exists only where a transport does.
     */
    symbol: string;
    /** The export name of the function. */
    name: string;
}

/**
 * Guard/middleware: veto by throwing (a `ServerFnError` sets the response
 * status); hand results downstream via `rq.locals`.
 */
export type ServerFnGuard = (rq: ServerFnContext, fn: ServerFnInfo) => void | Promise<void>;

/**
 * The full invocation pipeline (`use` guards → `input` validation → handler)
 * stamped on every wrapped function as `__sigxFn`. Transports call this with
 * a live context; the public callable wraps it with a detached one.
 */
export type ServerFnInvoke = (
    rq: ServerFnContext,
    info: ServerFnInfo,
    args: unknown[]
) => Promise<unknown>;

/**
 * Per-call options — the explicit channel (`fn.with({ signal })(…args)`)
 * that keeps the wire args exactly the user's args (no trailing-argument
 * sniffing). `signal` today; rev-2 `headers` and the SSR-context escape
 * hatch extend the same bag later.
 */
export interface ServerFnCallOptions {
    /**
     * Aborts the in-flight call: on the client the fetch is aborted; on an
     * in-process (SSR) call it becomes `rq.abortSignal`.
     */
    signal?: AbortSignal;
    /**
     * One-off request headers for THIS call (rfc-server v2 per-call
     * options, #315) — merged over `configureServerFn`'s transport headers
     * (the per-call value wins), under the same rule: `content-type` is
     * never overridable (stripped case-insensitively; the endpoint 415s
     * anything else). Client-transport-only — an in-process (SSR-time)
     * call makes no HTTP request, so it is ignored there with a `__DEV__`
     * warning, the mirror of `context` being ignored on the client.
     */
    headers?: Record<string, string>;
    /**
     * Bypass HTTP caches for THIS call of a cache-marked GET read
     * (rfc-server §4.1's deferred per-call freshness escape, #315): sets
     * `cache: 'no-cache'` on the fetch, so the browser revalidates with
     * the origin instead of answering from `max-age`. Meaningless on POST
     * (never HTTP-cached) and in-process — a `__DEV__`-warned no-op there.
     */
    fresh?: boolean;
    /**
     * The request context for an IN-PROCESS (SSR-time) call — a `Request`,
     * or a partial context to override more (#352).
     *
     * Without it, `rq.request`/`rq.url` throw on an in-process call, so a
     * function shaped `sessionFrom(rq.request)` works over RPC and breaks
     * during SSR. Hand the real request in:
     *
     * ```ts
     * await getCart.with({ context: ssrRequest })(cartId);
     * ```
     *
     * Wins over the ambient context `runWithServerFnContext` installs
     * (`@sigx/server/node`, #309) — explicit beats ambient. **Ignored on the
     * client**: a stub's context is the HTTP request it makes, and silently
     * accepting one there would imply it travelled.
     */
    context?: ServerFnContextInit;
}

/**
 * A server-fn reference used as a DATA-KEY pattern (rfc-server §6.2) — any
 * callable carrying the build-stamped stable key. The parameter type is
 * `never[]` so every function shape matches structurally.
 */
export interface ServerFnKeyRef {
    (...args: never[]): unknown;
    __sigxKey?: string;
}

/**
 * A pattern accepted by `invalidates` (§6.2): a canonical key string, a
 * tuple prefix (which may embed server-fn references as elements), or a
 * bare server-fn reference — the endpoint resolves references to their
 * stable-key tuples before anything reaches the wire.
 */
export type InvalidatePattern = string | readonly unknown[] | ServerFnKeyRef;

/**
 * The public callable shape of a wrapped server function — identical on the
 * server wrapper, the generated client stub, and the browser entry (the
 * build transform swaps values, never types).
 */
export type ServerFnCallable<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
    /** Bind per-call options; returns the same callable signature. */
    with(options?: ServerFnCallOptions): (...args: A) => Promise<R>;
    /**
     * The stable data key (`<stableId>#<name>`) behind `useData(fn)` and
     * fn-ref `invalidates` patterns. Declared REQUIRED for keying DX — the
     * property is what lets `useData(getVotes)` type-check while a plain
     * function does not. At runtime it is BUILD-stamped (the Vite transform
     * appends it to both the client stub and the SSR module); outside the
     * transform (unit tests, hand-wired non-Vite builds) it is absent and
     * `useData(fn)` dev-throws with the remedy.
     */
    __sigxKey: string;
} & WrappedServerFn;

/** A wrapped server function, as transports and registries see it. */
export interface WrappedServerFn {
    __sigxFn: ServerFnInvoke;
    __sigxName: string;
    /**
     * Present (true) on `serverStream` wrappers: `__sigxFn` resolves to an
     * AsyncGenerator and the endpoint streams NDJSON instead of buffering a
     * JSON envelope (rfc-server §6.1).
     */
    __sigxStream?: boolean;
    /**
     * Present (true) when the options form declared `cache` (rfc-server
     * §4.1) — the function is a side-effect-free idempotent read and the
     * endpoint accepts GET for it. The build transform reads the same
     * declaration statically so the stub issues GET.
     */
    __sigxGet?: boolean;
    /**
     * The precomputed `Cache-Control` value the endpoint emits on a 2xx GET
     * (rfc-server §4.1) — built once at definition time from the `cache`
     * declaration, so the per-request cost is one header set. Starts with
     * `public` iff the read opted into shared caches (the args-only
     * contract, §5.2a); the endpoint appends `Vary: Cookie` otherwise.
     */
    __sigxCacheControl?: string;
    /**
     * Present (true) when the options form declared `form: true`
     * (rfc-server §6.4) — the function is a declared FORM TARGET: the
     * endpoint accepts form content-types for it (FormData → single
     * input → the same validator/pipeline → 303 PRG), and the build
     * stamps `action`/`method` onto forms whose submit handler calls it.
     */
    __sigxForm?: boolean;
    /**
     * The build-stamped stable data key (`<stableId>#<name>`) — see
     * `ServerFnCallable.__sigxKey`. Optional here because it exists only
     * under the Vite transform; registries and transports never require it.
     */
    __sigxKey?: string;
    /**
     * Present when the options form declared `invalidates` (rfc-server
     * §6.2): VALIDATED input (stashed on the request context by the
     * pipeline) + settled result → patterns the endpoint RESOLVES (fn refs
     * → stable-key tuples) and attaches to the envelope as
     * `$cache.invalidates`.
     */
    __sigxInvalidates?(
        input: unknown,
        result: unknown
    ): ReadonlyArray<InvalidatePattern> | Promise<ReadonlyArray<InvalidatePattern>>;
}

/**
 * Minimal structural typing of the Standard Schema spec
 * (https://standardschema.dev — the interface Zod/Valibot/ArkType all
 * implement). Type-only: validating is calling `~standard.validate`, so no
 * runtime dependency is taken on any validator library.
 */
export interface StandardSchemaV1<Output = unknown> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        validate(
            value: unknown
        ): StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    };
}

export type StandardSchemaResult<Output> =
    | { value: Output; issues?: undefined }
    | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };
