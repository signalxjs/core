/**
 * The server-function request scope, as the document handlers see it
 * (`__SIGX_SERVERFN_SCOPE__` — docs/seams.md; rfc-server §7 v1.1, #309).
 *
 * A server function called IN-PROCESS during a render — which is what
 * `useData` does on the server — gets a context whose `rq.request` throws
 * unless something supplied the request. The handler is the only place that
 * can supply it for the WHOLE render: `useData` fetchers settle while chunks
 * are still being pumped, so a scope that ended at the shell would leave those
 * continuations request-less.
 *
 * Read through a global rather than an import because `@sigx/server` is an
 * optional pack: this package must not depend on it, and an app without server
 * functions must not pay for one. With no scope registered this is a direct
 * call — per-request `SSRContext` remains the isolation mechanism and
 * **AsyncLocalStorage is never required** (rfc-ssr-platform §2.3).
 */

interface ServerFnScope {
    run<T>(source: unknown, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Run `fn` with `source` (a WinterCG `Request` or a Node `IncomingMessage`) as
 * the ambient request for in-process server-function calls.
 *
 * Always returns a promise, even unscoped, so callers have one shape to await.
 * A scope that fails to open is not a render failure: `@sigx/server` degrades
 * to unscoped itself (a runtime without `node:async_hooks`), and anything
 * unexpected from a third-party scope is swallowed for the same reason — a
 * document must not 500 because ambient context was unavailable.
 */
export async function withServerFnScope<T>(source: unknown, fn: () => T | Promise<T>): Promise<T> {
    const scope = (globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope }).__SIGX_SERVERFN_SCOPE__;
    if (!scope) return fn();
    let opened: Promise<T>;
    try {
        opened = scope.run(source, fn);
    } catch (err) {
        // A throw from `run` ITSELF means the scope never opened, so `fn` has
        // not run — run it now, unscoped.
        if (__DEV__) {
            console.warn('[sigx] server-function scope failed to open; rendering unscoped:', err);
        }
        return fn();
    }
    return opened;
}
