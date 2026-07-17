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
    ServerFnGuard,
    ServerFnInvoke,
    StandardSchemaV1,
    WrappedServerFn
} from './types';

export { ServerFnError, isServerFnError, type ServerFnErrorShape } from './errors';
export type { ServerFnContext } from './context';
export type {
    ServerFnGuard,
    ServerFnInfo,
    ServerFnInvoke,
    StandardSchemaV1,
    WrappedServerFn
} from './types';

/** The options form — validation and middleware as part of the definition. */
export interface ServerFnOptions<S, R> {
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
    handler(rq: ServerFnContext, input: S): R | Promise<R>;
}

/** Wrap a server-only function. Client callers get `(...args) => Promise<R>`. */
export function serverFn<A extends unknown[], R>(
    impl: (rq: ServerFnContext, ...args: A) => R | Promise<R>
): ((...args: A) => Promise<Awaited<R>>) & WrappedServerFn;
export function serverFn<S, R>(
    options: ServerFnOptions<S, R>
): ((input: S) => Promise<Awaited<R>>) & WrappedServerFn;
export function serverFn(
    arg: ((rq: ServerFnContext, ...args: unknown[]) => unknown) | ServerFnOptions<unknown, unknown>
): ((...args: unknown[]) => Promise<unknown>) & WrappedServerFn {
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
            let input = args[0];
            if (options.input) {
                let result = options.input['~standard'].validate(input);
                if (result instanceof Promise) result = await result;
                if (result.issues) {
                    throw new ServerFnError(400, 'Invalid input', { issues: result.issues });
                }
                input = result.value;
            }
            return options.handler(rq, input);
        };
        name = options.handler.name || '';
    }

    // In-process (SSR-time) calls run the same pipeline against a detached
    // context — no network hop, and no transport symbol (rfc-server §7 v1).
    const wrapper = (...args: unknown[]) =>
        invoke(createDetachedContext(), { symbol: '', name }, args);
    return Object.assign(wrapper, { __sigxFn: invoke, __sigxName: name });
}
