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

/**
 * A node request is the one shape whose `headers` is a plain object (a
 * `Request`'s is a `Headers`, and a partial context usually has none).
 *
 * The `!== null` is load-bearing, not defensive noise: `typeof null` is
 * `'object'`, so without it a `{ headers: null }` source would be classified
 * as a node request and blow up in `Object.entries` instead of passing
 * through as a partial context.
 */
function isNodeRequest(value: unknown): value is NodeRequestLike {
    if (typeof value !== 'object' || value === null) return false;
    const headers = (value as { headers?: unknown }).headers;
    return (
        typeof headers === 'object' &&
        headers !== null &&
        typeof (headers as { get?: unknown }).get !== 'function'
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

/**
 * What a SCOPE stores: `toContextInit`, plus the one guarantee a scope adds —
 * a `locals` object (rfc-server-v3 §2.3, #494).
 *
 * That object IS the per-request store. `contextFrom` prefers a supplied
 * `locals` (`./context`), so every context derived inside this scope shares
 * one bag instead of minting a fresh `{}` per call — which is why a guard that
 * decoded a session could not hand it to the next call, and why one signed-in
 * render re-did the same decode once per cell.
 *
 * A source that ALREADY carries `locals` is stored as is, never copied: the
 * endpoint's own context and an app pre-seeding `{ request, locals: { user } }`
 * both hand in the bag they intend to be the store, and identity is what makes
 * it one. (Only that branch can hold a full `ServerFnContext` with the throwing
 * `request`/`url` getters `contextFrom` documents, so the spread below never
 * reads one.)
 *
 * With an `enclosing` scope open for the SAME request, the new source merges
 * over it rather than replacing it (§2.7, #495) — see {@link sameRequest}.
 */
export function toScopeInit(
    source: ScopeSource,
    enclosing?: Partial<ServerFnContext>
): Partial<ServerFnContext> {
    const init = toContextInit(source);
    // A bare Request is wrapped rather than left bare — nothing is lost:
    // `contextFrom` reads `partial.request`, derives `url` from it, and its
    // abortSignal fallback reaches `request.signal` through the same field.
    const incoming: Partial<ServerFnContext> =
        init instanceof Request ? { request: init } : init;

    if (enclosing && sameRequest(enclosing, incoming)) {
        // Prototype delegation rather than a spread OF THE ENCLOSING init: a
        // spread reads every enumerable property, and a context built by
        // `contextFrom` carries lazy `request`/`url` getters that throw when
        // nothing supplied a request. Inheriting leaves them lazy and keeps
        // `responseHeaders`/`status` pointing at the ones the outer scope owns.
        const merged: Partial<ServerFnContext> = Object.create(enclosing);
        for (const key of Object.keys(incoming) as (keyof ServerFnContext)[]) {
            // Supplied fields win; an explicit `undefined` must not shadow the
            // enclosing value. READING is what needs the guard: a context built
            // by `contextFrom` carries `request`/`url` as ENUMERABLE getters
            // that throw when nothing supplied a request, so an app forwarding
            // its own `rq` into a nested scope would otherwise crash the render
            // on a field it never set. A throwing getter means "not supplied".
            let value: unknown;
            try {
                value = incoming[key];
            } catch {
                continue;
            }
            if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
        }
        // One request, one store — the whole point. An inner source carrying
        // its OWN bag keeps it: that is the deliberate way to isolate a nested
        // render (a subrequest on behalf of a different principal, say).
        merged.locals = incoming.locals ?? enclosing.locals ?? {};
        return merged;
    }

    if (__DEV__ && enclosing) noticeFreshStore(enclosing, incoming);
    return incoming.locals ? incoming : { ...incoming, locals: {} };
}

/**
 * "Same URL + method means the same request" (#506), computed defensively:
 * either side may be a bare `Partial<ServerFnContext>` with no request at all,
 * and the incoming side may be a `Request` the Node path just built from an
 * `IncomingMessage` — which is exactly why object identity was rejected as the
 * rule (it would leave the documented pre-seed recipe broken precisely where
 * it is documented).
 *
 * PROTOCOL is excluded deliberately: it is the one component two
 * normalizations of the same wire request legitimately disagree on
 * (`socket.encrypted` vs `x-forwarded-proto`), so including it would decline
 * the merge behind any TLS-terminating proxy. Host, path and query differing
 * means a different target.
 */
function requestKey(init: Partial<ServerFnContext>): string | undefined {
    try {
        const request = init.request;
        const url = init.url ?? (request ? new URL(request.url) : undefined);
        if (!url) return undefined;
        return `${(request?.method ?? 'GET').toUpperCase()} ${url.host}${url.pathname}${url.search}`;
    } catch {
        // A throwing `request` getter must not break a render; "no key" means
        // "makes no claim", which merges.
        return undefined;
    }
}

/**
 * No claim on either side merges — an app pre-seeding
 * `runWithServerFnContext({ locals: { user } }, …)` says nothing about which
 * request it is, and merging is unambiguously right there. Two claims must
 * agree.
 */
function sameRequest(outer: Partial<ServerFnContext>, incoming: Partial<ServerFnContext>): boolean {
    const a = requestKey(outer);
    const b = requestKey(incoming);
    return a === undefined || b === undefined || a === b;
}

/**
 * The latch lives on `globalThis`, not in a module variable, so "once per
 * process" is true rather than "once per module copy" — in dev the Vite module
 * runner and Node hold two copies of this module, the same hazard documented
 * for `__SIGX_SERVERFN_CONTEXT__`. Not a seam: nothing reads it across a
 * package boundary, it is dev-warning bookkeeping with no contract.
 */
const NESTED_NOTICE = Symbol.for('sigx.serverfn.warnedNestedRequest');

function noticeFreshStore(
    outer: Partial<ServerFnContext>,
    incoming: Partial<ServerFnContext>
): void {
    const latch = globalThis as Record<symbol, unknown>;
    if (latch[NESTED_NOTICE] === true) return;
    latch[NESTED_NOTICE] = true;
    console.warn(
        `[sigx server] a nested server-function scope names a different request ` +
        `(${requestKey(outer)} → ${requestKey(incoming)}), so it gets its OWN request store: ` +
        `\`rq.locals\` and per-request values from the enclosing scope are not shared with it. ` +
        `Same URL + method nests into one store (docs/rfc-server-v3.md §2.7). ` +
        `Fires once per process.`
    );
}

/** The slice of AsyncLocalStorage this uses — typed here so the module needs
 *  no `node:async_hooks` types at build time. */
interface ContextStore {
    run<R>(ctx: Partial<ServerFnContext>, fn: () => R): R;
    getStore(): Partial<ServerFnContext> | undefined;
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
        .then(({ AsyncLocalStorage }) => new AsyncLocalStorage<Partial<ServerFnContext>>())
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
    // No ALS: nothing encloses anything, so there is nothing to merge and no
    // notice to give — this runtime never had a scope to nest in.
    if (!store) return fn();
    // `getStore()` AFTER the await deliberately: AsyncLocalStorage follows
    // async continuations, so this still reads the scope of whoever called.
    // No cast: `run` hands back exactly what `fn` returned — a value or a
    // promise — and this function being async settles either into Promise<T>.
    return store.run(toScopeInit(source, store.getStore()), fn);
}

// The seam. Stamped at IMPORT, unlike `__SIGX_SERVERFN_CONTEXT__` (which
// cannot exist before a scope does): `@sigx/server-renderer` must be able to
// ask "can I open a scope?" on the first request, and every server entry
// imports this module transitively.
((globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope }).__SIGX_SERVERFN_SCOPE__ ??= {
    run: runInScope
});
