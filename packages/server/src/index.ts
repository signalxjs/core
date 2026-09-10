/**
 * @sigx/server — server functions (RPC) for SignalX (docs/rfc-server.md,
 * #302/#305; consolidated for 1.0 by docs/rfc-server-v5.md, #692).
 *
 * `serverFn` wraps a function whose body runs only on the server. Authored
 * in `*.server.ts` modules (the whole module is server-only), it is a PLAIN
 * async function to callers — `useData`/`useAction` and the `@sigx/cache`
 * pack compose with zero integration code. The `@sigx/vite/server` plugin
 * swaps the module for typed fetch stubs in the client build; on the server
 * the import is this real module, so a call is a direct invocation.
 *
 * ```ts
 * // src/cart.server.ts
 * import { serverFn, requirePrincipal } from '@sigx/server';
 *
 * export const addToCart = serverFn({
 *     input: AddToCart,                       // Standard Schema — runs on every transport
 *     handler: async ({ input: { productId, qty }, rq }) => {
 *         const user = await requirePrincipal<User>(rq);
 *         return db.cart.add(user.id, productId, qty);
 *     }
 * });
 * ```
 *
 * The endpoint half lives in `@sigx/server/server` (WinterCG) and
 * `@sigx/server/node` (connect-style); the transform's stubs in
 * `@sigx/server/client`. (Not to be confused with `@sigx/server-renderer`,
 * which renders documents — this package is how your app talks to the
 * server.)
 */

import { runAuthorize, runServerPrelude } from './app-config';
import { resolveInProcessContext, type ServerFnContext } from './context';
import { ServerFnError } from './errors';
import { fnNameOf } from './fn-name';
import type {
    InvalidatePattern,
    ServerFnCallOptions,
    ServerFnCallable,
    ServerFnDescriptor,
    ServerFnHandlerArgs,
    ServerFnInvoke,
    ServerPolicy,
    ServerStreamCallOptions,
    ServerStreamCallable,
    StandardSchemaV1
} from './types';

export { ServerFnError, isServerFnError, type ServerFnErrorShape } from './errors';
export { perRequest, disposeRequestValues, type PerRequestDispose } from './per-request';
export {
    principal,
    requirePrincipal,
    setPrincipal,
    requireAuthenticated,
    serverFeature
} from './app-config';
export type { ServerFnContext } from './context';
export type {
    EndpointPosture,
    InvalidatePattern,
    ServerFeatureContext,
    ServerFeatureOp,
    ServerFnCallOptions,
    ServerFnCallable,
    ServerFnDescriptor,
    ServerFnHandlerArgs,
    ServerFnInfo,
    ServerFnInvoke,
    ServerFnKeyRef,
    ServerFnRegistry,
    ServerFnRegistryEntry,
    ServerMiddleware,
    ServerPolicy,
    ServerPolicyOp,
    ServerStreamCallOptions,
    ServerStreamCallable,
    StandardSchemaV1,
    WrappedServerFn
} from './types';

/**
 * HTTP cache declaration for an idempotent read (rfc-server §4.1).
 * Declaring it marks the function a SIDE-EFFECT-FREE read: the stub issues
 * GET and the endpoint emits `Cache-Control` from these values, so browser
 * and edge caches can absorb read traffic. The promise is the author's —
 * a mutating function marked `cache` re-opens CSRF completely (§5.2a).
 */
export interface ServerFnReadCache {
    /** Seconds the response is fresh in HTTP caches (`max-age`). No invented default. */
    maxAge: number;
    /** `stale-while-revalidate` window, seconds. */
    staleWhileRevalidate?: number;
    /**
     * Shared-cache opt-in: emits `public` (+ `s-maxage`) instead of the
     * default `private`. Contract (§5.2a): a public read's output depends
     * ONLY on its arguments — never cookies, auth, or request headers.
     */
    public?: boolean;
    /** Shared-cache TTL when `public`; defaults to `maxAge`. */
    sMaxAge?: number;
}

/**
 * The definition of a server function (rfc-server-v5 §1.1 — the ONLY
 * authoring form): validation, access and transport declarations next to
 * the implementation. Every function takes exactly one `input`, or none.
 */
export interface ServerFnOptions<S, R> {
    /**
     * Explicit stable id (rfc-server rev 2, N.3) — a NON-EMPTY string
     * literal, read statically by the build; the runtime ignores it, and
     * anything else (a variable, a template, `''`) is a build error. Pins
     * the function's route and data key (`<id>/<name>`) across file moves —
     * for published APIs long-lived native clients call.
     */
    id?: string;
    /**
     * Input validator (Standard Schema — Zod/Valibot/ArkType all qualify).
     * ALWAYS runs server-side before the handler, on every transport;
     * rejection throws a `ServerFnError(400, 'Invalid input', { issues })`.
     * Also the inference source for `S`: omit it and `S` falls back to the
     * handler's annotation (`({ input }: { input: Foo })`) — with neither
     * the input is undeclared, `S` defaults to `void`, and the callable
     * takes no argument (#454). Wire input can still arrive and reaches the
     * handler unvalidated (dev-warned, #437) — the zero-argument signature
     * types your own call sites, it does not gate the transport.
     */
    input?: StandardSchemaV1<S>;
    /**
     * This function's authorization requirement (rfc-server-v4 §1.2) —
     * REPLACES the app default for this function (most-specific-wins);
     * policies in an array AND together. Runs AFTER `input` validation, so a
     * policy sees the validated input as the resource (`op.input`), and only
     * ever a non-null principal unless {@link allowAnonymous} is declared.
     * Presence is read statically by the build's `requireAuthorization`
     * check; the values are runtime.
     */
    authorize?: ServerPolicy | ServerPolicy[];
    /**
     * Waives ONLY the identity gate — this function is reachable without a
     * principal (rfc-server-v4 §1.2). Middleware and authentication still
     * run (an existing session still yields a principal, so rate limiting
     * stays per-user and audit logs stay attributed), and any declared
     * {@link authorize} policies still run, receiving a nullable principal.
     *
     * Write the LITERAL `true` — the build reads it statically, the same
     * discipline `form` has, and the runtime records it on the descriptor
     * (`__sigx.anon`) so the endpoint can gate before decoding attacker
     * bytes. Spelled as a word rather than as absence because "deliberately
     * open to anonymous callers" and "forgot to protect" must not look
     * identical — and it makes the open surface greppable:
     * `grep -rn allowAnonymous --include='*.server.ts' src/` prints every
     * anonymous-reachable endpoint, a list a security review can read.
     */
    allowAnonymous?: true;
    /**
     * Server-declared cache invalidation (rfc-server §6.2): which cache
     * keys this mutation invalidates, computed WHERE the data changed so
     * it cannot drift from the mutation. Runs after the handler resolves;
     * the endpoint attaches the keys to the response envelope as
     * `$cache.invalidates`, and `@sigx/cache` feeds them to `invalidate()`
     * on arrival. Patterns follow `invalidate()`'s contract: a canonical
     * string, a tuple prefix (`['cart']` matches every cart key), or a
     * server-fn REFERENCE — `[getVotes]` or bare `getVotes` — which the
     * endpoint resolves to the fn's stable-key tuple (`useData(getVotes)`'s
     * identity), so the declaration stays same-module and rename-safe.
     * ALSO the single-flight boundary-refresh gate (rfc-server §6.3): the
     * client sends its boundaries' recorded data deps up with the call,
     * and the endpoint re-renders those whose deps intersect these
     * patterns into `$boundaries` — a never-hydrated boundary then updates
     * without loading its chunk. One declaration, both convergence paths.
     * Wire-only — in-process calls skip it (there is no envelope).
     * TypeScript note: write it AFTER `handler` in the options literal —
     * context-sensitive members infer in textual order, so `result` falls
     * to `unknown` when this precedes the handler.
     */
    invalidates?(
        input: S,
        result: Awaited<R>
    ): ReadonlyArray<InvalidatePattern> | Promise<ReadonlyArray<InvalidatePattern>>;
    /**
     * Marks the function a cacheable idempotent read (rfc-server §4.1):
     * the client stub issues GET with the arguments in the query string,
     * and the endpoint emits `Cache-Control` from this declaration
     * (`private` + `Vary: Cookie` by default; `public` is an explicit
     * opt-in under the args-only contract, §5.2a). POST stays valid.
     * Mutually exclusive with `invalidates` — a read that invalidates is
     * not a read; declaring both is a definition-time error (in production
     * too, #567). Layering with `@sigx/cache`'s staleTime: §6.2.
     */
    cache?: ServerFnReadCache;
    /**
     * Marks the function a FORM TARGET (rfc-server §6.4): the endpoint
     * accepts `application/x-www-form-urlencoded` / `multipart/form-data`
     * for it — FormData is normalized to this fn's single input (flat
     * object; repeated names → array; File passed through; values stay
     * strings, so Standard Schema coercion like `z.coerce.number()` is
     * the mapping tool) — and answers 303 POST-redirect-GET. The build
     * stamps `action`/`method` onto a resume `<form>` whose submit
     * handler calls this fn, so the native POST works before/without JS.
     *
     * **The no-JS half needs a RESUME component.** Stamping happens in the
     * `sigxResume()` extractor, so it reaches only files matching that
     * plugin's `include` (`*.resume.tsx` / `resume/**` by default), and only
     * components that extract in `resume` mode — one unextractable capture
     * demotes the component and the action goes with it. A `<form>` anywhere
     * else still works as RPC, it just has no native fallback. Both cases
     * warn at build time since #488; before that they were silent.
     * Write the LITERAL `true` — the build reads it statically, and the
     * type accepts only the literal (`form: someBool` is a build error).
     * REQUIRES `input` (definition-time error without it, #412): form
     * fields are attacker-typable strings and the validator is what stands
     * between them and the handler (§5.2b). Mutually exclusive with `cache`
     * — a form target is a mutation; declaring both is a definition-time
     * error (in production too, #567).
     */
    form?: true;
    /**
     * The implementation — ONE object parameter (rfc-server-v5 §1.2):
     * destructure `input` and/or `rq`. `input` arrives validated when
     * {@link input} is declared. WITHOUT a schema, annotate the parameter
     * (`({ input }: { input: Foo })`) — `S` infers from the schema or from
     * the annotation. Declaring neither is the input-less shape: `S`
     * defaults to `void` and the callable takes no argument (#454), while
     * wire input can still arrive unvalidated (dev-warned, #437).
     */
    handler(args: ServerFnHandlerArgs<S>): R | Promise<R>;
}

/**
 * Wrap a server-only function. Client callers get `(input?) => Promise<R>`.
 *
 * `S` defaults to `void` — an input-less handler (`handler({ rq })` /
 * `handler()`) gives S no inference source, so it falls to the default and
 * the callable takes ZERO arguments: `vote()`, not `vote(undefined)`
 * (#451). One signature, no overloads: the handler is context-sensitive,
 * and overload resolution with a context-sensitive member drops its
 * parameter to implicit `any` (TS quirk), while a lone signature
 * contextually types every shape correctly.
 */
export function serverFn<S = void, R = unknown>(
    options: ServerFnOptions<S, R>
): ServerFnCallable<[S] extends [void] ? [] : [S], Awaited<R>> {
    return createServerFn(options as ServerFnOptions<unknown, unknown>) as ServerFnCallable<
        [S] extends [void] ? [] : [S],
        Awaited<R>
    >;
}

/**
 * The body of `serverFn` (rfc-server §2.1, pipeline order per rfc-server-v4
 * §1.3). The ownership contract: a WIRE transport runs the prelude
 * (middleware → authenticate → identity gate) itself, before decoding
 * arguments; `invoke` runs it here only for in-process calls — which is why
 * it starts with the transport check. Authorization (phase B) is inside
 * `invoke` on every transport, so the access decision never depends on the
 * transport behaving.
 */
function createServerFn(options: ServerFnOptions<unknown, unknown>): ServerFnCallable<unknown[], unknown> {
    const declared = options.authorize;
    const anon = options.allowAnonymous === true;
    // #437: the remaining unvalidated gap — no `input` schema means the
    // (single) wire arg reaches the handler as-is, and if the handler
    // parameter is unannotated the stub's argument type is `unknown` too.
    // Surfaced once per fn in dev; zero-arg calls carry no attacker input.
    let warnedWire = false;
    const invoke: ServerFnInvoke = async (rq, info, args) => {
        if (info.transport === 'in-process') await runServerPrelude(rq, info, anon);
        if (__DEV__ && !warnedWire && !options.input && info.transport === 'wire' && args.length > 0) {
            warnedWire = true;
            console.warn(
                `[sigx server] serverFn "${info.name || info.symbol}" received a wire ` +
                `argument with no \`input\` validator — wire input is attacker-controlled; ` +
                `the handler's parameter type is compile-time only. Declare \`input\` ` +
                `(Standard Schema — Zod/Valibot/ArkType; rfc-server §5). Fires once per function.`
            );
        }
        // A server function takes ONE input (matching its signature) —
        // extra wire args would silently bypass the declared shape.
        if (args.length > 1) {
            throw new ServerFnError(400, 'server functions take a single input argument');
        }
        let input = args[0];
        if (options.input) {
            let result = options.input['~standard'].validate(input);
            if (result instanceof Promise) result = await result;
            if (result.issues) {
                throw new ServerFnError(400, 'Invalid input', { issues: result.issues });
            }
            input = result.value;
        }
        // Stash the VALIDATED input for the endpoint's `invalidates`
        // call (§6.2) — per-request context, so concurrency-safe.
        (rq as { _input?: unknown })._input = input;
        // Phase B — after validation, so a policy's `op.input` is the
        // trusted resource (rfc-server-v4 §1.3), immediately before the
        // handler. Order pinned by test.
        await runAuthorize(rq, { fn: info, input }, declared, anon);
        return options.handler({ input, rq });
    };

    // In-process (SSR-time) calls run the same pipeline against a detached
    // context — no network hop. `.with(options)` is the per-call options
    // channel (#353): explicit, so the wire args stay exactly the user's
    // args. The identity is read off the wrapper at CALL time: the build
    // stamps `__sigxKey` after this function returns, and reading it lazily
    // is what gives middleware and audit logs the same `info.symbol` on the
    // in-process transport as on the wire (rfc-server-v5 §1.3).
    const callWith =
        (callOptions?: ServerFnCallOptions) =>
        (...args: unknown[]) => {
            const key = wrapper.__sigxKey;
            assertNotLiveClient(fnNameOf(key));
            if (__DEV__ && callOptions && ('headers' in callOptions || 'fresh' in callOptions)) {
                // The mirror of `.with({ context })` being ignored on the
                // client: transport options mean nothing without a transport.
                console.warn(
                    `[sigx server] .with({ ${'headers' in callOptions ? 'headers' : 'fresh'} }) is ` +
                    `ignored on an in-process (SSR-time) call — there is no HTTP request to ` +
                    `apply it to. It only affects the client stub's fetch (#315).`
                );
            }
            return invoke(
                resolveInProcessContext(callOptions?.signal, callOptions?.context),
                { symbol: key, name: fnNameOf(key), transport: 'in-process' },
                args
            );
        };
    const wrapper = callWith() as ServerFnCallable<unknown[], unknown>;
    // The §6.2 seam for the ENDPOINT (wire-only — the wrapper above never
    // computes directives): validated input + settled result → keys.
    const invalidates = options.invalidates;
    // The §4.1 read marker: precompute the Cache-Control value once, at
    // definition time — the endpoint's per-request cost is one header set.
    const cache = options.cache;
    if (cache && invalidates) {
        // #567: NOT __DEV__-gated, the posture of the two throws below. The
        // endpoint resolves this contradiction SILENTLY — a GET answer never
        // carries `$cache.invalidates`, and with no patterns the §6.3
        // boundary refresh never runs for it either — so in production the
        // symptom is stale client caches and dead refresh, with no signal at
        // any layer. That is exactly where a dev-only warning is not present.
        throw new Error(
            `[sigx server] serverFn declares both \`cache\` and \`invalidates\` — a read ` +
            `that invalidates is not a read (rfc-server §4.1). The endpoint drops the ` +
            `\`invalidates\` declaration on the GET path: no client cache is ever told, ` +
            `and single-flight boundary refresh (§6.3) never runs for it. Split them — ` +
            `keep \`cache\` on the read, and move the write with its \`invalidates\` ` +
            `into its own serverFn.`
        );
    }
    // Coherence check (rfc-server-v4 §1.4): a `public` cached read whose
    // identity gate still applies would serve per-principal 200s under a
    // shared-cache header — the §5.2a mistake, now statically visible. A
    // public read's output depends only on its arguments, so it should also
    // be reachable without a principal.
    if (__DEV__ && cache?.public === true && !anon) {
        console.warn(
            `[sigx server] serverFn declares \`cache.public\` without \`allowAnonymous: ` +
            `true\` — a public Cache-Control header lets shared caches store the ` +
            `response, but the identity gate still requires a principal, so ` +
            `authenticated responses would be cached publicly (rfc-server §5.2a). A ` +
            `public read depends only on its arguments; declare \`allowAnonymous: true\`, ` +
            `or drop \`public\`.`
        );
    }
    // The §6.4 form-target marker: the endpoint's gate for accepting form
    // content-types, and the build's for stamping action/method.
    const form = options.form === true;
    if (form && !options.input) {
        // #412: NOT __DEV__-gated — the no-JS form transport delivers an
        // attacker-typed string map straight to the handler, and a dev-only
        // warning is silent exactly where it matters. A definition-time
        // throw fails at boot/CI, never per-request (the
        // `assertNotLiveClient` posture: throws are this package's only
        // prod-visible channel).
        throw new Error(
            `[sigx server] serverFn declares \`form\` without \`input\` — the no-JS form ` +
            `transport delivers an attacker-typed string map straight to the handler, ` +
            `and the validator is the only thing between them (rfc-server §5.2b). ` +
            `Declare a Standard Schema \`input\`. To accept the raw field map ` +
            `deliberately, declare a pass-through schema: { '~standard': { version: 1, ` +
            `vendor: 'app', validate: (v) => ({ value: v }) } }.`
        );
    }
    if (form && cache) {
        // #567: NOT __DEV__-gated — see the `cache` + `invalidates` throw
        // above. These two also program opposite transports, so the
        // contradiction is not even resolvable at request time.
        throw new Error(
            `[sigx server] serverFn declares both \`form\` and \`cache\` — a form target ` +
            `is a mutation, and a cacheable read cannot be one (rfc-server §6.4). They ` +
            `also program opposite transports: \`cache\` makes the stub issue a GET with ` +
            `the arguments in the URL, while a form POSTs fields. Drop \`cache\` here, or ` +
            `drop \`form\` if this really is a read.`
        );
    }
    // ONE frozen descriptor (rfc-server-v5 §1.5) — everything a transport
    // reads off the wrapper, minted once. Frozen so `read` cannot exist
    // without its `cacheControl` and the endpoint needs no combination
    // defence. `__sigxKey: ''` is the UNSTAMPED value (#565): the real key
    // is BUILD-stamped (the Vite transform appends the assignment to the
    // SSR module) and nothing here can know it; minting the empty string
    // keeps the declared type (required `string`, which is what makes
    // `useData(getVotes)` type-check) true in every environment. `''` is
    // already what both readers mean by "no key".
    const descriptor: ServerFnDescriptor = Object.freeze({
        kind: 'fn' as const,
        invoke,
        anon,
        form,
        ...(cache ? { read: Object.freeze({ cacheControl: cacheControlValue(cache) }) } : {}),
        ...(invalidates ? { invalidates: invalidates.bind(options) } : {})
    });
    return Object.assign(wrapper, {
        with: callWith,
        __sigx: descriptor,
        __sigxKey: ''
    });
}

/** rfc-server §4.1's header-emission table, as one precomputed string. */
function cacheControlValue(cache: ServerFnReadCache): string {
    const swr =
        cache.staleWhileRevalidate !== undefined
            ? `, stale-while-revalidate=${cache.staleWhileRevalidate}`
            : '';
    return cache.public
        ? `public, max-age=${cache.maxAge}, s-maxage=${cache.sMaxAge ?? cache.maxAge}${swr}`
        : `private, max-age=${cache.maxAge}${swr}`;
}

/**
 * A declared live client (lynx/terminal — `declareLiveClient()` stamps the
 * global; rfc-server rev 2 N.2) must never execute server bodies locally:
 * reaching a real wrapper there means the build skipped the stub swap.
 * Checked at CALL time (robust to declaration ordering) and not
 * __DEV__-gated, matching the browser-condition posture. A global marker,
 * not a runtime-core import — this package stays dependency-free of the
 * runtime.
 */
function assertNotLiveClient(name: string): void {
    if ((globalThis as { __SIGX_LIVE_CLIENT__?: boolean }).__SIGX_LIVE_CLIENT__ === true) {
        throw new Error(
            `[sigx server] server function ${name ? `"${name}" ` : ''}reached a live client ` +
            `unextracted — this app must call its backend over stubs (set role: 'client' in ` +
            `sigxServer(), or fix the bundler integration).`
        );
    }
}

/**
 * The definition of a server stream (rfc-server §6.1; one shape since
 * rfc-server-v5 §1.1) — `serverFn`'s declarations minus the ones that only
 * make sense for a buffered JSON answer (`cache`, `form`, `invalidates`,
 * `id`). A stream is a public endpoint too, so the build's
 * `requireAuthorization` check holds it to the same rule.
 */
export interface ServerStreamOptions<S, T> {
    /**
     * Input validator (Standard Schema) and the inference source for `S`;
     * rejection throws `ServerFnError(400, 'Invalid input', { issues })`
     * before the first chunk, on every transport: over the wire a rejection
     * is a buffered JSON 400 (headers still writable, no stream byte sent);
     * in-process it surfaces on the first pull. Per-chunk concerns stay the
     * generator's own. Omitted: the single wire argument reaches the
     * handler unvalidated (dev-warned).
     */
    input?: StandardSchemaV1<S>;
    /**
     * This stream's authorization requirement — same contract as
     * `serverFn`'s (rfc-server-v4 §1.2): replaces the app default, ANDs in
     * an array, runs after validation and before the first chunk on every
     * transport. A veto surfaces in-process on the first pull, where the
     * wire path's pre-first-yield error surfaces too.
     */
    authorize?: ServerPolicy | ServerPolicy[];
    /**
     * Waives ONLY the identity gate — middleware, authentication and any
     * declared `authorize` policies still run (rfc-server-v4 §1.2). Write
     * the LITERAL `true`; the build reads it statically.
     */
    allowAnonymous?: true;
    /** The implementation — `async function* ({ input, rq })`. */
    handler(args: ServerFnHandlerArgs<S>): AsyncGenerator<T>;
}

/**
 * Wrap a server-only async generator (rfc-server §6.1). Client callers get
 * `(input?) => AsyncIterable<T>`: over the wire each yield is an NDJSON
 * `{"chunk"}` line (then `{"done"}` / `{"error"}`); in-process the call is
 * the generator itself — no transport, same pipeline discipline. A
 * string-yielding stream plugs into `useStream` as-is. Response headers
 * freeze at the first yield (unlike `serverFn`'s buffered JSON, where
 * `rq.responseHeaders`/`rq.status()` apply until the body is written).
 *
 * Carries the same `.with(options)` per-call channel as `serverFn` (#448),
 * minus `fresh` — a stream is never HTTP-cached. `S = void` mirrors
 * `serverFn` (#454): no `input` and no annotation yields a zero-arg
 * callable.
 */
export function serverStream<S = void, T = unknown>(
    options: ServerStreamOptions<S, T>
): ServerStreamCallable<[S] extends [void] ? [] : [S], T> {
    return createServerStream(options as ServerStreamOptions<unknown, T>) as ServerStreamCallable<
        [S] extends [void] ? [] : [S],
        T
    >;
}

/** `serverStream`'s body — same ownership contract as `createServerFn`. */
function createServerStream<T>(options: ServerStreamOptions<unknown, T>): ServerStreamCallable<unknown[], T> {
    const policies = options.authorize;
    const anon = options.allowAnonymous === true;
    const input = options.input;
    // #437: the same unvalidated-wire-input surface as serverFn, same
    // once-per-fn dev signal. A declared `input` closes it.
    let warnedWire = false;
    // Async so transports get a settled value to marker-check; the resolved
    // value is the (not-yet-started) generator. Everything here — prelude,
    // validation, authorization — lands BEFORE the generator starts:
    // buffered 400/401/403 on the wire, first-pull rejection in-process.
    const invoke: ServerFnInvoke = async (rq, info, args) => {
        if (info.transport === 'in-process') await runServerPrelude(rq, info, anon);
        if (__DEV__ && !warnedWire && !input && info.transport === 'wire' && args.length > 0) {
            warnedWire = true;
            console.warn(
                `[sigx server] serverStream "${info.name || info.symbol}" received a wire ` +
                `argument with no \`input\` validator — wire input is attacker-controlled; ` +
                `the handler's parameter type is compile-time only. Declare \`input\` ` +
                `(Standard Schema — Zod/Valibot/ArkType; rfc-server §5). Fires once per function.`
            );
        }
        if (args.length > 1) {
            throw new ServerFnError(400, 'server functions take a single input argument');
        }
        let value = args[0];
        if (input) {
            let result = input['~standard'].validate(value);
            if (result instanceof Promise) result = await result;
            if (result.issues) {
                throw new ServerFnError(400, 'Invalid input', { issues: result.issues });
            }
            value = result.value;
        }
        await runAuthorize(rq, { fn: info, input: value }, policies, anon);
        return options.handler({ input: value, rq });
    };
    /**
     * The in-process body, as an async generator so `callWith` can keep
     * returning an `AsyncIterable` SYNCHRONOUSLY while `invoke` — which is
     * async — runs on the first pull. `yield*`, never `for await`: delegation
     * forwards `.return()`/`.throw()` to the handler's generator, so a
     * consumer that `break`s still runs its `finally`.
     */
    async function* pump(rq: ServerFnContext, args: unknown[]): AsyncGenerator<T> {
        const key = wrapper.__sigxKey ?? '';
        yield* (await invoke(rq, { symbol: key, name: fnNameOf(key), transport: 'in-process' }, args)) as AsyncGenerator<T>;
    }
    // `.with(options)` — the same per-call channel as serverFn's, minus
    // `fresh` (#448). #362 left streams out on the strength of the signal
    // argument alone (consumer break/return already aborts), which said
    // nothing about the other two: an SSR-time stream needs the real request
    // where ALS is unavailable, and a client stream needs one-off headers.
    const callWith =
        (callOptions?: ServerStreamCallOptions) =>
        (...args: unknown[]): AsyncIterable<T> => {
            assertNotLiveClient(fnNameOf(wrapper.__sigxKey ?? ''));
            if (__DEV__ && callOptions && 'headers' in callOptions) {
                // The mirror of `.with({ context })` being ignored on the
                // client: transport options mean nothing without a transport.
                console.warn(
                    `[sigx server] .with({ headers }) is ignored on an in-process ` +
                    `(SSR-time) stream — there is no HTTP request to apply it to. It only ` +
                    `affects the client stub's fetch (#315).`
                );
            }
            // Explicit beats ambient, exactly as for serverFn: an explicit
            // context wins over `runWithServerFnContext`, and with neither the
            // detached context's `request`/`url` throw descriptively. Resolved
            // HERE, at call time — the ambient scope belongs to whoever
            // called, not to whoever first pulls a chunk.
            const rq = resolveInProcessContext(callOptions?.signal, callOptions?.context);
            // rfc-server-v3 §1.2 (F-B): an in-process stream runs the SAME
            // pipeline the wire does. A veto surfaces on the first pull —
            // which is exactly where the wire path's pre-first-yield error
            // surfaces too.
            return pump(rq, args);
        };
    const wrapper = callWith() as ServerStreamCallable<unknown[], T>;
    const descriptor: ServerFnDescriptor = Object.freeze({
        kind: 'stream' as const,
        invoke,
        anon,
        form: false
    });
    return Object.assign(wrapper, {
        with: callWith,
        __sigx: descriptor
    });
}
