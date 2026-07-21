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
 *
 * A scope that fails to open must not fail the document — ambient context is
 * an enhancement, and `createFetchHandler` owes its caller a Response either
 * way. But "the scope broke" and "the render threw" arrive through the same
 * channel, and re-running a render that already ran would render twice or bury
 * a real error. So the fallback keys off whether `fn` actually STARTED: if it
 * did, its failure is the render's and propagates untouched; if it never ran,
 * the scope is at fault and the render is retried unscoped — whether `run`
 * threw synchronously or rejected later.
 */
export async function withServerFnScope<T>(source: unknown, fn: () => T | Promise<T>): Promise<T> {
    const scope = (globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope }).__SIGX_SERVERFN_SCOPE__;
    if (!scope) return fn();
    let started = false;
    try {
        return await scope.run(source, () => {
            started = true;
            return fn();
        });
    } catch (err) {
        if (started) throw err; // the render's own failure, not the scope's
        if (__DEV__) {
            console.warn('[sigx] server-function scope failed to open; rendering unscoped:', err);
        }
        return fn();
    }
}
