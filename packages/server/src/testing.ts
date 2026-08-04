/**
 * @sigx/server/testing — the public testing surface (#570, deferred from
 * rfc-server v3 and shipped there; extended by rfc-server-v4 §2.4).
 *
 * Three helpers close the gaps unit tests hit:
 *
 * - `createTestServerFnContext()` — a real, Request-backed `ServerFnContext`
 *   with zero ceremony, so `rq.request`/`rq.url` never throw the detached
 *   error and `rq.status()` records instead of warning. Its `principal`
 *   option seeds the identity memo, which is the correct unit-test shape:
 *   you test a handler under an identity, not through the cookie parser.
 *   Hand it to `fn.with({ context })(…)`, which already runs the WHOLE
 *   in-process pipeline — middleware, authentication, the identity gate,
 *   arity gate, `input` validation, authorization — so there is
 *   deliberately no separate "invoker" helper.
 * - `stubServerApp()` — stamp an app config (middleware / authenticate /
 *   authorize) for integration-shaped tests; returns the restore.
 * - `stampServerFnKey()` — the build stamp `useData(fn)` requires, minted
 *   by the Vite transform in an app and therefore absent in a unit test.
 *
 * Test-ORIENTED, not dev-only: the helpers behave identically against the
 * prod dists (only the defensive `__DEV__` throws strip), so a test run
 * against production bundles does not silently change context semantics.
 * The context helpers keep no module state; `stubServerApp` writes the ONE
 * `__SIGX_SERVER_APP__` seam through the same accessor production uses —
 * immune to the dual-module-copy hazard for the same reason.
 */

import { setPrincipal, stampServerAppConfig, type ServerAppConfig } from './app-config';
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
 *
 * `opts.principal` seeds the identity memo on the context's request store,
 * so the app's `authenticate` never runs and the identity gate passes —
 * inject `null` explicitly to pin the anonymous path. Omitting it leaves
 * authentication to whatever `stubServerApp` configured (nothing configured
 * ⇒ anonymous ⇒ non-`allowAnonymous` functions deny, the fail-closed
 * default).
 */
export function createTestServerFnContext(
    init?: ServerFnContextInit,
    opts?: { principal?: unknown }
): TestServerFnContext {
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
    if (opts && 'principal' in opts) setPrincipal(ctx, opts.principal);
    return ctx;
}

/**
 * Stamp an app config — middleware, `authenticate`, the default `authorize`
 * — for integration-shaped tests, through the same `__SIGX_SERVER_APP__`
 * accessor production uses. Returns the restore; call it in the test's
 * teardown so a stamped config never leaks across tests (the seam is
 * process-global, last-wins).
 *
 * ```ts
 * const restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
 * try { await expect(boardIssues(key)).resolves.toEqual(…); }
 * finally { restore(); }
 * ```
 *
 * For a plain unit test of one handler, prefer
 * `createTestServerFnContext(init, { principal })` — injecting the identity
 * directly tests the handler, not the cookie parser.
 */
export function stubServerApp(config: ServerAppConfig): () => void {
    const previous = stampServerAppConfig(config);
    return () => {
        stampServerAppConfig(previous);
    };
}

/**
 * Stamp the build-provided markers a `useData(fn)` target needs.
 *
 * In an app the Vite transform appends `fn.__sigxKey = '<stableId>/<name>'`
 * to the server module; a unit test has no transform, so `useData(fn)`
 * dev-throws on the minted `''` sentinel. This helper is that stamp, on the SAME function — mutating on
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
    return fn;
}
