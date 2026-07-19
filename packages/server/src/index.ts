/**
 * @sigx/server — server functions (RPC) for SignalX (docs/rfc-server.md,
 * #302/#305).
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
 * import { serverFn, ServerFnError } from '@sigx/server';
 *
 * export const addToCart = serverFn(async (rq, productId: string, qty: number) => {
 *     const user = await sessionFrom(rq.request);
 *     if (!user) throw new ServerFnError(401, 'sign in first');
 *     return db.cart.add(user.id, productId, qty);
 * });
 * ```
 *
 * The endpoint half lives in `@sigx/server/server` (WinterCG) and
 * `@sigx/server/node` (connect-style); the transform's stubs in
 * `@sigx/server/client`. (Not to be confused with `@sigx/server-renderer`,
 * which renders documents — this package is how your app talks to the
 * server.)
 */

import { createDetachedContext, type ServerFnContext } from './context';
import { ServerFnError } from './errors';
import type {
    ServerFnCallOptions,
    ServerFnCallable,
    ServerFnGuard,
    ServerFnInvoke,
    StandardSchemaV1,
    WrappedServerFn
} from './types';

export { ServerFnError, isServerFnError, type ServerFnErrorShape } from './errors';
export type { ServerFnContext } from './context';
export type {
    ServerFnCallOptions,
    ServerFnCallable,
    ServerFnGuard,
    ServerFnInfo,
    ServerFnInvoke,
    StandardSchemaV1,
    WrappedServerFn
} from './types';

/** The options form — validation and middleware as part of the definition. */
export interface ServerFnOptions<S, R> {
    /**
     * Explicit stable id (rfc-server rev 2, N.3) — a NON-EMPTY string
     * literal, read statically by the build; the runtime ignores it, and
     * anything else (a variable, a template, `''`) is warned about and falls
     * back to the file-derived id. Pins the function's routes (`<id>#<name>`
     * and the hashed twin) across file moves — for published APIs
     * long-lived native clients call.
     */
    id?: string;
    /**
     * Input validator (Standard Schema — Zod/Valibot/ArkType all qualify).
     * ALWAYS runs server-side before the handler, on every transport;
     * rejection throws a `ServerFnError(400, 'Invalid input', { issues })`.
     */
    input?: StandardSchemaV1<S>;
    /**
     * Definition-level middleware — runs before the handler on EVERY
     * transport (RPC, in-process SSR call), so it cannot be skipped the way
     * route-level middleware can. Veto by throwing; hand off via `rq.locals`.
     */
    use?: ServerFnGuard[];
    /**
     * Server-declared cache invalidation (rfc-server §6.2): which cache
     * keys this mutation invalidates, computed WHERE the data changed so
     * it cannot drift from the mutation. Runs after the handler resolves;
     * the endpoint attaches the keys to the response envelope as
     * `$cache.invalidates`, and `@sigx/cache` feeds them to `invalidate()`
     * on arrival. Patterns follow `invalidate()`'s contract: a canonical
     * string, or a tuple prefix (`['cart']` matches every cart key).
     * Wire-only — in-process calls skip it (there is no envelope).
     * TypeScript note: write it AFTER `handler` in the options literal —
     * context-sensitive members infer in textual order, so `result` falls
     * to `unknown` when this precedes the handler.
     */
    invalidates?(
        input: S,
        result: Awaited<R>
    ):
        | ReadonlyArray<string | readonly unknown[]>
        | Promise<ReadonlyArray<string | readonly unknown[]>>;
    handler(rq: ServerFnContext, input: S): R | Promise<R>;
}

/** Wrap a server-only function. Client callers get `(...args) => Promise<R>`. */
export function serverFn<A extends unknown[], R>(
    impl: (rq: ServerFnContext, ...args: A) => R | Promise<R>
): ServerFnCallable<A, Awaited<R>>;
export function serverFn<S, R>(options: ServerFnOptions<S, R>): ServerFnCallable<[S], Awaited<R>>;
export function serverFn(
    arg: ((rq: ServerFnContext, ...args: unknown[]) => unknown) | ServerFnOptions<unknown, unknown>
): ServerFnCallable<unknown[], unknown> {
    let invoke: ServerFnInvoke;
    let name: string;

    if (typeof arg === 'function') {
        invoke = async (rq, _info, args) => arg(rq, ...args);
        name = arg.name || '';
    } else {
        const options = arg;
        invoke = async (rq, info, args) => {
            for (const guard of options.use ?? []) {
                await guard(rq, info);
            }
            // The options form takes ONE input (matching its signature) —
            // extra wire args would silently bypass the declared shape.
            if (args.length > 1) {
                throw new ServerFnError(400, 'options-form server functions take a single input argument');
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
            return options.handler(rq, input);
        };
        name = options.handler.name || '';
    }

    // In-process (SSR-time) calls run the same pipeline against a detached
    // context — no network hop, and no transport symbol (rfc-server §7 v1).
    // `.with(options)` is the per-call options channel (#353): explicit, so
    // the wire args stay exactly the user's args.
    const callWith =
        (options?: ServerFnCallOptions) =>
        (...args: unknown[]) => {
            assertNotLiveClient(name);
            return invoke(createDetachedContext(options?.signal), { symbol: '', name }, args);
        };
    const wrapper = callWith();
    // The §6.2 seam for the ENDPOINT (wire-only — the wrapper above never
    // computes directives): validated input + settled result → keys.
    const invalidates = typeof arg === 'function' ? undefined : arg.invalidates;
    return Object.assign(wrapper, {
        with: callWith,
        __sigxFn: invoke,
        __sigxName: name,
        ...(invalidates ? { __sigxInvalidates: invalidates } : {})
    });
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
    if ((globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__ === true) {
        throw new Error(
            `[sigx server] server function ${name ? `"${name}" ` : ''}reached a live client ` +
            `unextracted — this app must call its backend over stubs (set role: 'client' in ` +
            `sigxServer(), or fix the bundler integration).`
        );
    }
}

/**
 * Wrap a server-only async generator (rfc-server §6.1). Client callers get
 * `(...args) => AsyncIterable<T>`: over the wire each yield is an NDJSON
 * `{"chunk"}` line (then `{"done"}` / `{"error"}`); in-process the call is
 * the generator itself — no transport, same pipeline discipline. A
 * string-yielding stream plugs into `useStream` as-is. Response headers
 * freeze at the first yield (unlike `serverFn`'s buffered JSON, where
 * `rq.responseHeaders`/`rq.status()` apply until the body is written).
 */
export function serverStream<A extends unknown[], T>(
    impl: (rq: ServerFnContext, ...args: A) => AsyncGenerator<T>
): ((...args: A) => AsyncIterable<T>) & WrappedServerFn {
    const name = impl.name || '';
    // Async so transports get a settled value to marker-check; the resolved
    // value is the (not-yet-started) generator.
    const invoke: ServerFnInvoke = async (rq, _info, args) => impl(rq, ...(args as A));
    const wrapper = (...args: A): AsyncIterable<T> => {
        assertNotLiveClient(name);
        return impl(createDetachedContext(), ...args);
    };
    return Object.assign(wrapper, { __sigxFn: invoke, __sigxName: name, __sigxStream: true as const });
}
