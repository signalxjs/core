/**
 * @sigx/server/testing — the public testing surface (#570, deferred from
 * rfc-server v3 and shipped here).
 *
 * Two helpers close the two gaps unit tests hit:
 *
 * - `createTestServerFnContext()` — a real, Request-backed `ServerFnContext`
 *   with zero ceremony, so `rq.request`/`rq.url` never throw the detached
 *   error and `rq.status()` records instead of warning. Hand it to
 *   `fn.with({ context })(…)`, which already runs the WHOLE in-process
 *   pipeline — preset guards, the `use` chain, arity gate, `input`
 *   validation — so there is deliberately no separate "invoker" helper.
 * - `stampServerFnKey()` — the build stamp `useData(fn)` requires, minted
 *   by the Vite transform in an app and therefore absent in a unit test.
 *
 * Test-ORIENTED, not dev-only: both helpers behave identically against the
 * prod dists (only the defensive `__DEV__` throws strip), so a test run
 * against production bundles does not silently change context semantics.
 * No module state, no globals — immune to the dual-module-copy hazard the
 * context seam itself has to defend against.
 */

import {
    contextFrom,
    type ServerFnContext,
    type ServerFnContextInit
} from './context';
import type { WrappedServerFn } from './types';

/**
 * The context `createTestServerFnContext` returns — a full `ServerFnContext`
 * plus the assertion channel for `rq.status()`.
 */
export interface TestServerFnContext extends ServerFnContext {
    /** The last code a handler passed to `rq.status(code)`; `undefined` if never called. */
    readonly statusCode: number | undefined;
}

/**
 * Build a Request-backed test context.
 *
 * - With no arguments: `new Request('http://localhost/')`, fresh `locals`,
 *   fresh `responseHeaders` — everything a handler touches works.
 * - With a `Request`: `url`/`headers`/`abortSignal` derive from it.
 * - With a partial context: the supplied fields win; anything missing gets
 *   the test default — including `request`, which is this factory's whole
 *   point (a bare partial through `fn.with({ context })` keeps the detached
 *   throw; the factory never does).
 *
 * Isolation follows the store-identity rule (`docs/rfc-server-v3.md` §7):
 * the `locals` object IS the per-request store, held by identity. One
 * factory context used across several `fn.with({ context: ctx })(…)` calls
 * is ONE request (`perRequest` values shared); two factory calls are two.
 *
 * `rq.status(code)` records to `.statusCode` (readable, non-enumerable)
 * instead of dev-warning "inert" on every call — unless the caller supplied
 * their own `status`.
 */
export function createTestServerFnContext(init?: ServerFnContextInit): TestServerFnContext {
    // Guarded per-key reads, NEVER a spread: a previously built context has
    // enumerable throwing `request`/`url` getters, and spreading it would
    // invoke them (the same discipline contextFrom itself documents).
    const partial: Partial<ServerFnContext> = {};
    if (init) {
        const source: Partial<ServerFnContext> =
            init instanceof Request ? { request: init } : init;
        for (const key of [
            'request',
            'url',
            'abortSignal',
            'responseHeaders',
            'status',
            'locals'
        ] as const) {
            try {
                const value = source[key];
                if (value !== undefined) (partial as Record<string, unknown>)[key] = value;
            } catch {
                // A throwing getter (detached context as init) reads as absent.
            }
        }
    }
    // Constructed inside the function body — workerd forbids module-scope
    // Request construction, the same discipline detachedSignal() follows.
    partial.request ??= new Request('http://localhost/');
    // Caller identity preserved, never cloned — the store-identity rule.
    partial.locals ??= {};
    let recorded: number | undefined;
    if (partial.status === undefined) {
        partial.status = (code: number): void => {
            recorded = code;
        };
    }
    const ctx = contextFrom(partial) as TestServerFnContext;
    // Non-enumerable: a context handed into runWithServerFnContext or a
    // nested scope merge enumerates keys, and a test-only property must not
    // ride into merged scopes.
    Object.defineProperty(ctx, 'statusCode', {
        get: (): number | undefined => recorded,
        enumerable: false
    });
    return ctx;
}

/**
 * Stamp the build-provided markers a `useData(fn)` target needs.
 *
 * In an app the Vite transform appends `fn.__sigxKey = '<stableId>/<name>'`
 * (and `fn.__sigxGuardChecked = true`) to the server module; a unit test
 * has no transform, so `useData(fn)` dev-throws on the minted `''`
 * sentinel. This helper is that stamp, on the SAME function — mutating on
 * purpose, because identity is load-bearing: `useData` keys on the
 * reference, and a wrapper would break the brand checks and `.with()`.
 *
 * The default key is `test/<name>` (the `<stableId>/<name>` shape); pass an
 * explicit key when a test asserts specific cache keys. Streams are
 * rejected in dev — a stream is not a `useData` target and the transform
 * stamps no key for one.
 */
export function stampServerFnKey<F extends Partial<WrappedServerFn>>(fn: F, key?: string): F {
    if (__DEV__) {
        if (key === '') {
            throw new TypeError(
                `[sigx server/testing] stampServerFnKey: '' is the UNSTAMPED sentinel — ` +
                `both readers treat it as absent, so stamping it would change nothing ` +
                `while the types say otherwise. Pass a non-empty key, or omit it.`
            );
        }
        if (fn.__sigxStream === true) {
            throw new TypeError(
                `[sigx server/testing] stampServerFnKey: a serverStream is not a useData ` +
                `target (the build stamps no key for one) — a stamped stream would make ` +
                `useData await an AsyncIterable. Stream results belong in useStream.`
            );
        }
    }
    fn.__sigxKey = key ?? `test/${fn.__sigxName || 'fn'}`;
    fn.__sigxGuardChecked = true;
    return fn;
}
