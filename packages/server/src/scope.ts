/**
 * The ambient request SCOPE — the write half of what #379 landed as a read
 * half (rfc-server §7 v1.1, #309).
 *
 * `resolveInProcessContext` (`./context`) reads the ambient request through
 * `__SIGX_SERVERFN_CONTEXT__`. Something has to OPEN that scope, and the
 * document handlers in `@sigx/server-renderer` are where it belongs: they own
 * the request for the whole render, including the async continuations —
 * `useData` fetchers settling while chunks stream — that a hand-rolled wrap
 * around `renderToString` would miss. That package cannot import this one
 * (`@sigx/server` is an optional pack), so the runner is published as a
 * second seam, `__SIGX_SERVERFN_SCOPE__`, stamped when this module loads.
 *
 * Why this module rather than `./node`: `node:async_hooks` is imported
 * DYNAMICALLY, so nothing here is Node-only at load time, and every server
 * entry — WinterCG `./server` included — can register the scope by import
 * alone. A workerd app gets ambient context from the `@sigx/server/server`
 * import it already has; only its `nodejs_compat` flag decides whether the
 * store materializes.
 */

import type { ServerFnContext, ServerFnContextInit } from './context';

/** What a scope can be opened with. */
export type ScopeSource = ServerFnContextInit | NodeRequestLike;

/**
 * The parts of Node's `IncomingMessage` a scope reads. Structural on purpose:
 * `node:http` must never be imported here — this module is reachable from the
 * WinterCG-clean entries, where a `node:` import is a deployment failure.
 */
export interface NodeRequestLike {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { encrypted?: boolean };
}

/** The capability `@sigx/server-renderer` reaches through the seam. */
export interface ServerFnScope {
    run<T>(source: ScopeSource, fn: () => T | Promise<T>): Promise<T>;
}

/** A node request is the one shape whose `headers` is a plain object. */
function isNodeRequest(value: unknown): value is NodeRequestLike {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { headers?: unknown }).headers === 'object' &&
        typeof (value as { headers?: { get?: unknown } }).headers?.get !== 'function'
    );
}

/**
 * A Node `IncomingMessage` → the `Request` in-process callers read.
 *
 * Built EAGERLY, once per scope: `contextFrom` reads `request`/`url` off the
 * init as soon as any in-process call resolves its context, so lazy getters
 * here would buy nothing but indirection.
 *
 * No body (a document render needs headers and a URL, not the payload) and no
 * abort signal — a node request's `close` fires on normal completion too, so
 * wiring it here would abort renders that succeeded. A Node app that wants
 * disconnect-cancellation for SSR-time work passes its own `Request` with an
 * `AbortController` wired to `res` (see `runWithServerFnContext`); under
 * `createFetchHandler` the platform's own Request already carries one.
 */
function requestFromNode(req: NodeRequestLike): Request {
    const first = (value: string | string[] | undefined): string =>
        String(Array.isArray(value) ? value[0] : (value ?? ''))
            .split(',')[0]
            .trim();
    // Behind a TLS-terminating proxy the socket is plaintext but the browser's
    // URL is https — honor the standard forwarded headers, as `toWebRequest`
    // does for the endpoint.
    const proto = first(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
    const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || 'localhost';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
    }
    return new Request(`${proto}://${host}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers
    });
}

/** Normalize whatever opened the scope into what `./context` understands. */
export function toContextInit(source: ScopeSource): ServerFnContextInit {
    return isNodeRequest(source)
        ? requestFromNode(source)
        : (source as Request | Partial<ServerFnContext>);
}

/** The slice of AsyncLocalStorage this uses — typed here so the module needs
 *  no `node:async_hooks` types at build time. */
interface ContextStore {
    run<R>(ctx: ServerFnContextInit, fn: () => R): R;
    getStore(): ServerFnContextInit | undefined;
}

let _storePromise: Promise<ContextStore | null> | undefined;
let _warnedNoStore = false;

/**
 * Create the ALS once per process and (re-)stamp the resolver seam on every
 * scope entry.
 *
 * The AsyncLocalStorage is memoized — one store, so nested scopes nest — but
 * the seam is re-asserted each time rather than only on first use: it is a
 * global, and anything may clobber or delete it (a test teardown, another copy
 * of this module, a host that resets globals between requests). The write is a
 * property assignment; re-doing it is cheaper than the class of bug where the
 * store exists but nothing can read it.
 *
 * Resolves to `null` where `node:async_hooks` does not exist (workerd without
 * `nodejs_compat`). That is a SUPPORTED state, not an error: the render runs
 * unscoped and in-process calls keep the detached context, exactly as before
 * this feature existed. A handler that wrapped every render must not 500 a
 * whole site over a missing compatibility flag.
 */
function ensureContextStore(): Promise<ContextStore | null> {
    _storePromise ??= import('node:async_hooks')
        .then(({ AsyncLocalStorage }) => new AsyncLocalStorage<ServerFnContextInit>())
        .catch(() => null);
    return _storePromise.then((als) => {
        if (!als) {
            if (__DEV__ && !_warnedNoStore) {
                _warnedNoStore = true;
                console.warn(
                    '[sigx server] node:async_hooks is unavailable, so SSR-time server-function ' +
                    'calls cannot see the request (on Cloudflare Workers add ' +
                    'compatibility_flags: ["nodejs_compat"]). fn.with({ context }) still works.'
                );
            }
            return null;
        }
        (
            globalThis as {
                __SIGX_SERVERFN_CONTEXT__?: () => ServerFnContextInit | undefined;
            }
        ).__SIGX_SERVERFN_CONTEXT__ = () => als.getStore();
        return als as unknown as ContextStore;
    });
}

/** Open a scope, or run `fn` unscoped when the runtime has no ALS. */
export async function runInScope<T>(source: ScopeSource, fn: () => T | Promise<T>): Promise<T> {
    const store = await ensureContextStore();
    if (!store) return fn();
    // No cast: `run` hands back exactly what `fn` returned — a value or a
    // promise — and this function being async settles either into Promise<T>.
    return store.run(toContextInit(source), fn);
}

// The seam. Stamped at IMPORT, unlike `__SIGX_SERVERFN_CONTEXT__` (which
// cannot exist before a scope does): `@sigx/server-renderer` must be able to
// ask "can I open a scope?" on the first request, and every server entry
// imports this module transitively.
((globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope }).__SIGX_SERVERFN_SCOPE__ ??= {
    run: runInScope
});
