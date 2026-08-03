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

/**
 * Structurally mirrors `@sigx/server`'s own declaration — this package cannot
 * import it, so the two are kept in step by hand (docs/seams.md is the
 * contract of record).
 *
 * `run` returns `T | Promise<T>`, not `Promise<T>`: only the FIRST scope entry
 * is asynchronous (that side resolves its AsyncLocalStorage through a dynamic
 * import); every one after it enters synchronously and hands back whatever
 * `fn` returned (#544). Await the result — never call `.then()` on it.
 *
 * Deliberately phrased without spelling that import as a call: the
 * WinterCG-purity guard in `__tests__/dependency-direction.test.ts` text-scans
 * these sources and cannot tell a comment from code.
 */
interface ServerFnScope {
    run<T>(source: unknown, fn: () => T | Promise<T>): T | Promise<T>;
    /**
     * OPTIONAL — an older `@sigx/server` stamped a seam without it, and that
     * pairing stays supported (its degraded state is exactly the pre-disposal
     * behavior). Extends the current scope's request-value disposal past
     * `run()`'s settle: disposal waits for `until` too (rfc-server-v3 §2.6,
     * phase 5). Callers feature-detect; never assume presence.
     */
    keepAlive?(until: Promise<unknown>): void;
}

/**
 * Run `fn` with `source` (a WinterCG `Request` or a Node `IncomingMessage`) as
 * the ambient request for in-process server-function calls.
 *
 * THIS function always returns a promise, even unscoped and even when the
 * underlying `scope.run` answers synchronously, so callers have one shape to
 * await. That normalisation is the point of the wrapper.
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
/**
 * Extend the CURRENT server-function scope's disposal until `until` settles
 * (rfc-server-v3 §2.6, phase 5): the streaming fetch handler calls this with
 * a promise resolved on body close/error/cancel, from inside the scope,
 * BEFORE returning its Response — the scope's `run()` settles at the shell,
 * and request values must outlive the shell by exactly the body.
 *
 * Feature-detecting pass-through: with no scope registered, or one from an
 * older `@sigx/server` without `keepAlive`, this is a supported no-op — the
 * degraded state is the pre-disposal behavior. Its own try/catch: a broken
 * seam must never fail a document.
 */
export function keepAliveServerFnScope(until: Promise<unknown>): void {
    try {
        // Optional call IS the feature detection; the catch covers a seam
        // whose `keepAlive` is present but broken — absence of effect is the
        // supported degraded state either way.
        (globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope }).__SIGX_SERVERFN_SCOPE__
            ?.keepAlive?.(until);
    } catch {
        /* supported no-op */
    }
}

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
