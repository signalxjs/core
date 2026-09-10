/**
 * Shared server-function types — split from index.ts so the WinterCG request
 * handler (`./server`) can import them without pulling the marker module in.
 */
import type { ServerFnContext, ServerFnContextInit } from './context';

/** Identity of the function being invoked, as the pipeline sees it. */
export interface ServerFnInfo {
    /**
     * The function's identity: the build-stamped stable key
     * (`<id>/<name>`), identical on the wire and in-process
     * (rfc-server-v5 §1.3). `''` means nothing stamped one (a unit test
     * importing the source module). Pure identity — the transport
     * discriminator is {@link ServerFnInfo.transport}.
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
 *
 * Cadence (#628): the chain runs once per OPERATION, not once per request —
 * every wire call, every stream open, and every in-process call runs it
 * again, so one SSR render with five data cells runs each middleware five
 * times. `authenticate`, right after it in the prelude, is memoized per
 * request store and runs once. Work that must happen once per request (a
 * request id, an audit record, a rate-limit debit) belongs in a
 * `perRequest` value the middleware touches, not in the middleware body.
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
     * The function's single input — VALIDATED when the definition declares
     * `input` (the resource for resource-based policies: "may P edit post
     * `op.input.id`"), the RAW wire argument when it does not (unvalidated,
     * attacker-controlled, dev-warned — treat it as untrusted), and
     * `undefined` when the call carried no argument at all.
     */
    input?: unknown;
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
 * One operation a {@link ServerFeatureContext.authorize} call decides — the
 * feature-facing spelling of {@link ServerPolicyOp} plus what the endpoint
 * normally reads off the wrapper (`policies`, `allowAnonymous`).
 */
export interface ServerFeatureOp<P = unknown> {
    fn: ServerFnInfo;
    /** This operation's declared chain; absent means the app default. */
    policies?: ServerPolicy<P> | readonly ServerPolicy<P>[];
    /**
     * The `allowAnonymous` literal. It does three things, not one, and a
     * feature author who reads it as "waives the identity gate" will
     * mis-declare an operation:
     *
     * 1. the gate in `prelude`/`enter` no longer 401s a `null` principal;
     * 2. in `authorize`, an operation declaring NO `policies` skips the
     *    app default and `requireAuthenticated` entirely — the defaults
     *    would re-deny exactly the anonymity this granted;
     * 3. declared `policies` still run, and now see a nullable principal,
     *    so they must handle `null` rather than assume an identity.
     */
    allowAnonymous?: boolean;
    /** Validated input, where the feature has one. A feature whose
     *  operation is a method call passes its argument list AS the input. */
    input?: unknown;
    /** The instance an operation targets — `@sigx/actors` fills this. */
    resource?: ServerPolicyOp['resource'];
}

/**
 * The endpoint-family seam (rfc-server-v4 §3.2, promoted in #625).
 *
 * A "feature" is an endpoint family other than `serverFns` — `@sigx/actors`
 * is the first — that owns its own wire shape but must run the SAME
 * pipeline: one middleware chain, one authenticator, one authorization
 * decision, one posture. It exists so a second family inherits those
 * instead of inventing them, which on the auth path is how transports drift
 * apart (the v3 §1.1 defect this whole RFC corrects).
 *
 * Every member resolves the app through the `__SIGX_SERVER_APP__` seam per
 * call, so a feature holds one of these at module scope and still sees the
 * live app — and, critically, needs no app handle at all: `@sigx/actors`
 * runs this pipeline from `actor()` call sites that have a context but no
 * platform entry in scope.
 *
 * Fail-closed throughout: no app configured means no middleware, a `null`
 * principal, and therefore a deny for anything not `allowAnonymous`.
 *
 * Anonymity on the wire is read off the WRAPPER, not passed by the feature:
 * `handleServerFnRequest` runs the prelude with `fn.__sigx.anon`
 * (`server/index.ts`), the flag `serverFn` / `serverStream` record from
 * `allowAnonymous: true` (see {@link ServerFnDescriptor.anon}). A feature
 * that synthesizes its own wrappers and hands them to core's endpoint must
 * carry a descriptor the same way —
 * otherwise its anonymous-allowed operations work in-process (where the
 * feature passes `allowAnonymous` itself) and 401 on the wire (#628).
 */
export interface ServerFeatureContext<P = unknown> {
    /**
     * Wire entry, for a feature that owns the raw `Request` (rfc-1.0 §4.2):
     * build the request context, then run middleware → authenticate → the
     * identity gate for one operation, and hand the context back. This is
     * the only public path from a `Request` to a context. A feature that
     * already holds a context (an in-process call, a connection that built
     * one) uses {@link ServerFeatureContext.prelude} instead.
     */
    enter(
        request: Request,
        fn: ServerFnInfo,
        options?: { allowAnonymous?: boolean }
    ): Promise<ServerFnContext>;
    /**
     * The same prelude over a context the feature already has — middleware
     * → authenticate (memoized per request store) → identity gate. Throws
     * `ServerFnError(401)` when the operation needs a principal and there
     * is none. Per operation, like the rest of the pipeline: calling it N
     * times on one context runs the middleware chain N times and
     * `authenticate` once (see {@link ServerMiddleware}).
     */
    prelude(
        rq: ServerFnContext,
        fn: ServerFnInfo,
        options?: { allowAnonymous?: boolean }
    ): Promise<void>;
    /**
     * Phase B — the authorization decision for one operation, run after the
     * feature has validated whatever it validates. Strict-`true`; throws
     * `ServerFnError` 403, or 401 when the principal is null.
     */
    authorize(rq: ServerFnContext, op: ServerFeatureOp<P>): Promise<void>;
    /** The app's merged endpoint posture; `{}` when no app is configured. */
    readonly posture: Readonly<EndpointPosture>;
    /**
     * The app's principal codec — the cross-hop propagation contract
     * (rfc-server-v4 §7). `undefined` when the app declares none, which a
     * feature must treat as "propagate nothing", never as "trust the hop".
     *
     * NOT the wire codec (`__SIGX_SERVERFN_CODEC__`): that one round-trips
     * arguments, this one round-trips identity, and conflating them would
     * make a request-supplied value decode into a principal.
     */
    readonly principalCodec:
        | { encode(principal: unknown): string; decode(encoded: string): unknown | null }
        | undefined;
    /**
     * Namespace bookkeeping — NOT routing. "Everything after `base` is the
     * symbol" (#543) means two families cannot share a base; claiming an
     * overlapping prefix throws at mount time, naming both. Scoped to the
     * currently stamped app, so a fresh app starts with a clean slate; a
     * no-op when none is configured, there being nothing to collide with.
     */
    claimBase(base: string): void;
}

/**
 * The full invocation pipeline carried by every wrapped function as
 * `__sigx.invoke`: for an in-process call it runs everything — middleware →
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

/** What a `serverFn` / `serverStream` handler receives — ONE object
 *  (rfc-server-v5 §1.2). Destructure what you need; a member added later
 *  (a typed principal, a signal) is a minor, never a positional break. */
export interface ServerFnHandlerArgs<S> {
    /**
     * The VALIDATED input when `input` is declared; otherwise the raw
     * single wire argument (dev-warned), or `undefined` for an input-less
     * function.
     */
    input: S;
    /** The request context — the same object policies and middleware see. */
    rq: ServerFnContext;
}

/**
 * Everything a transport or registry reads off a wrapped function
 * (rfc-server-v5 §1.5) — minted ONCE at definition time and frozen, so a
 * partial shape (a `read` without its `cacheControl`) cannot exist and the
 * endpoint needs no combination defence. Streams carry `kind: 'stream'`
 * and never `read` / `invalidates`.
 */
export interface ServerFnDescriptor {
    readonly kind: 'fn' | 'stream';
    /** The full pipeline — see {@link ServerFnInvoke}. */
    readonly invoke: ServerFnInvoke;
    /**
     * `allowAnonymous: true` was declared (rfc-server-v4 §1.2) — the
     * identity gate is waived. Recorded by the RUNTIME wrapper (not the
     * build), so a wire transport can run the gate before decoding attacker
     * bytes without the build's help.
     */
    readonly anon: boolean;
    /**
     * `form: true` was declared (rfc-server §6.4) — the endpoint accepts
     * form content-types for it (FormData → single input → the same
     * validator/pipeline → 303 PRG). Always `false` for a stream.
     */
    readonly form: boolean;
    /**
     * Present iff `cache` was declared (rfc-server §4.1): the function is a
     * side-effect-free read the endpoint accepts GET for, and
     * `cacheControl` is the precomputed `Cache-Control` value a 2xx GET
     * emits (starts with `public` iff the read opted into shared caches;
     * the endpoint appends `Vary: Cookie` otherwise).
     */
    readonly read?: { readonly cacheControl: string };
    /**
     * Present iff `invalidates` was declared (rfc-server §6.2): VALIDATED
     * input (stashed on the request context by the pipeline) + settled
     * result → patterns the endpoint RESOLVES (fn refs → stable-key tuples)
     * and attaches to the envelope as `$cache.invalidates`.
     */
    readonly invalidates?: (
        input: unknown,
        result: unknown
    ) => ReadonlyArray<InvalidatePattern> | Promise<ReadonlyArray<InvalidatePattern>>;
}

/** A wrapped server function, as transports and registries see it. */
export interface WrappedServerFn {
    readonly __sigx: ServerFnDescriptor;
    /**
     * The build-stamped stable data key (`<id>/<name>`) — see
     * `ServerFnCallable.__sigxKey`. Optional HERE, and honestly so: this
     * interface describes a FOREIGN object (a registry entry, a hand-built
     * transport shape) where the property may genuinely be absent, unlike a
     * callable this package minted. The intersection in `ServerFnCallable`
     * collapses the two to the required `string`. The ONLY cross-package
     * brand: `@sigx/runtime-core` keys `useData(fn)` on it and never reads
     * `__sigx`.
     */
    __sigxKey?: string;
}

/**
 * One registry record — what `virtual:sigx-server-fns` emits per function
 * (rfc-server-v5 §4.3), keyed by the stable key `<id>/<name>`.
 */
export interface ServerFnRegistryEntry {
    /** Lazy import of the wrapped function. */
    load(): Promise<unknown>;
    /**
     * This build's version tag for the function — hash8 of its normalized
     * definition (rfc-server-v5 §4.2). The stub sends it with every call;
     * the endpoint answers 409 `version-skew` when a client's differs.
     */
    readonly version: string;
}

/**
 * Key (`<id>/<name>`) → entry. Null-prototype when emitted by the build, so
 * a wire key named `__proto__` never resolves to an inherited member; the
 * endpoint's resolver applies its own own-property check regardless.
 */
export type ServerFnRegistry = Record<string, ServerFnRegistryEntry>;

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
