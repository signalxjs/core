/**
 * Shared server-function types — split from index.ts so the WinterCG request
 * handler (`./server`) can import them without pulling the marker module in.
 */
import type { ServerFnContext, ServerFnContextInit } from './context';

/** Identity of the function being invoked, as the pipeline sees it. */
export interface ServerFnInfo {
    /**
     * The content-hashed transport symbol (`<name>_fn_<hash8>`), or the
     * stable id under `role: 'client'`. Pure IDENTITY — `''` means nothing
     * stamped one (a unit test importing the source module); it no longer
     * doubles as the transport discriminator (rfc-server-v4 §1.1), which is
     * {@link ServerFnInfo.transport}.
     */
    symbol: string;
    /** The export name of the function. */
    name: string;
    /**
     * The transport discriminator: `'wire'` for the four HTTP transports
     * (POST JSON, GET reads, form posts, NDJSON streams), `'in-process'`
     * for SSR-time and direct server-side calls. Replaces the old
     * `symbol === ''` contract — middleware that must not run for renders
     * branches on this: `if (fn.transport !== 'wire') return;`.
     */
    transport: 'wire' | 'in-process';
}

/**
 * Middleware (rfc-server-v4 §1.1): app-global, ordered, runs on EVERY
 * transport, before-only — no `next()`, no around-ness (a standing
 * non-goal). Veto by throwing (a `ServerFnError` sets the response status —
 * a rate limiter throws 429 here); hand results downstream via `rq.locals`
 * or a `perRequest` value. Never sees arguments: on the wire it runs before
 * `reviveWire` on attacker-controlled bytes (#559), and it loses nothing by
 * going first. Transport-specific behavior is the body's own branch on
 * `fn.transport`.
 */
export type ServerMiddleware = (rq: ServerFnContext, fn: ServerFnInfo) => void | Promise<void>;

/**
 * An authorization policy (rfc-server-v4 §1.1) — the per-operation
 * requirement, run AFTER input validation so `op.input` is trustworthy.
 * Positional so the dominant case reads bare: `(p) => p.role === 'admin'`.
 * Policies in an array AND together.
 *
 * The runtime is STRICT: only the literal `true` allows — `false`, and any
 * accidental non-boolean, deny (403; 401 when the principal is null). A
 * thrown `ServerFnError` passes through verbatim for a custom status.
 */
export type ServerPolicy<P = unknown> = (
    /** `null` reaches a policy only on an `allowAnonymous` function. */
    principal: P | null,
    rq: ServerFnContext,
    op: ServerPolicyOp
) => boolean | Promise<boolean>;

/** The operation a {@link ServerPolicy} is deciding. */
export interface ServerPolicyOp {
    fn: ServerFnInfo;
    /**
     * VALIDATED single input (options-form fn / input-form stream) — the
     * resource for resource-based policies ("may P edit post
     * `op.input.id`"). `undefined` on the direct form and no-input streams.
     */
    input?: unknown;
    /**
     * The raw argument list — for multi-argument direct/stream forms this
     * is unvalidated wire data, the same trust level the handler receives.
     */
    args: readonly unknown[];
    /**
     * Filled by packs whose operations target an instance — `@sigx/actors`
     * passes `{ kind: 'actor', type, key, method }` (rfc-server-v4 §7).
     * Core wire calls leave it undefined.
     */
    resource?: { kind: string; type: string; key: string; method: string };
}

/**
 * The endpoint posture (rfc-server-v4 §3.1) — the wire-facing limits and
 * hooks an app states ONCE on `createServerApp` and every mount inherits;
 * an explicit per-mount/per-handler value wins over the app's. The keys are
 * `ServerFnRequestOptions`' wire knobs, split out so the platform value can
 * carry them without the endpoint's `resolve`/`base` plumbing.
 */
export interface EndpointPosture {
    /** Origin policy — `ServerFnRequestOptions.origin`'s exact contract. */
    origin?: 'same-origin' | 'verify-when-present' | string[] | false;
    /** Request body cap in bytes. Default 1 MiB. */
    maxBodyBytes?: number;
    /** GET read query-string cap in bytes (414). Default 8 KiB. */
    maxUrlBytes?: number;
    /** Outbound response-body cap in bytes (#571). Default unlimited. */
    maxResponseBytes?: number;
    /** Upper bound on pipeline + handler (+ first chunk) in ms (504). */
    timeoutMs?: number;
    /** Observability seam (#349) — called for every MASKED failure. */
    onError?(error: unknown, info: ServerFnInfo, ctx: ServerFnContext): void | Promise<void>;
}

/**
 * The full invocation pipeline stamped on every wrapped function as
 * `__sigxFn`: for an in-process call it runs everything — middleware →
 * authenticate → identity gate → arity → `input` validation → authorize →
 * handler; a wire transport owns the first three itself, pre-decode, and
 * `invoke` runs the rest (rfc-server-v4 §1.3's ownership contract). A
 * hand-rolled transport that skips its half never skips the authorization
 * DECISION — authorization (which pulls authentication on demand) is
 * inside `invoke` — but it does lose middleware, and it loses the
 * pre-decode ordering: without the transport-side gate, anonymous
 * attacker bytes reach the arity gate and the validator before the deny
 * lands, where the real endpoint refuses them first. Transports call this
 * with a live context; the public callable wraps it with a detached one.
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
 * Per-call options for a `serverStream` (#448) — the same channel as
 * `serverFn`'s, minus `fresh`. A stream is always POST and is therefore
 * never answered from an HTTP cache (rfc-server §4.1: "`serverStream` never
 * qualifies"), so `fresh` could only ever be a no-op; leaving it out makes
 * that a compile error instead of a dev warning. `signal`, `context` and
 * `headers` carry their `serverFn` meanings exactly — including the
 * mirrored ignores (`context` on the client, `headers` in-process).
 */
export type ServerStreamCallOptions = Omit<ServerFnCallOptions, 'fresh'>;

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
     * The stable data key (`<stableId>/<name>`) behind `useData(fn)` and
     * fn-ref `invalidates` patterns. ALWAYS a string — `''` means this build
     * stamped no key (unit tests, hand-wired non-Vite builds).
     *
     * Declared REQUIRED on purpose: it is what lets `useData(getVotes)`
     * type-check while a plain function does not. The gate is runtime-core's
     * `ServerFnDataRef.__sigxKey: string`, and making either side optional
     * removes the gate entirely — TypeScript skips weak-type detection for a
     * type with call signatures, so a callable whose members are all optional
     * accepts every function.
     *
     * Since #565 the runtime honors that declaration rather than contradicting
     * it: `serverFn()` mints `''` and `__serverFnStub` falls back to `''`, so
     * `fn.__sigxKey.length` can no longer crash on a value the type calls a
     * `string`. `''` is already what both readers mean by "absent" —
     * `isServerFnDataRef` and the endpoint's invalidate-pattern resolver each
     * test `key !== ''` — so `useData(fn)` still dev-throws with the remedy on
     * an unstamped function, and unstamped fn-ref patterns are still dropped
     * with a warning.
     */
    __sigxKey: string;
} & WrappedServerFn;

/**
 * The public callable shape of a wrapped `serverStream` — identical on the
 * server wrapper and the generated client stub (the build transform swaps
 * values, never types). No `__sigxKey`: a stream is not a `useData` target,
 * and the extractor stamps no key for one.
 */
export type ServerStreamCallable<A extends unknown[], T> = ((...args: A) => AsyncIterable<T>) & {
    /** Bind per-call options; returns the same callable signature. */
    with(options?: ServerStreamCallOptions): (...args: A) => AsyncIterable<T>;
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
     * The build-stamped stable data key (`<stableId>/<name>`) — see
     * `ServerFnCallable.__sigxKey`. Optional HERE, and honestly so: this
     * interface describes a FOREIGN object (a registry entry, a hand-built
     * transport shape) where the property may genuinely be absent, unlike a
     * callable this package minted. The intersection in `ServerFnCallable`
     * collapses the two to the required `string`.
     */
    __sigxKey?: string;
    /**
     * Present (true) when the definition declared `allowAnonymous: true`
     * (rfc-server-v4 §1.2) — the identity gate is waived for this function.
     * Stamped by the RUNTIME wrapper (not the build), so a wire transport
     * can run the gate before decoding attacker bytes without the build's
     * help.
     */
    __sigxAnon?: boolean;
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
