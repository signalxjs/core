/**
 * @sigx/server/node — the connect-style adapter over the WinterCG handler
 * (rfc-server §2), the sibling of `@sigx/server-renderer/node`'s
 * `createRequestHandler`. Everything that touches `node:` lives here; the
 * package's other entries run on edge runtimes unchanged.
 *
 * ```js
 * import { createServerFnHandler } from '@sigx/server/node';
 *
 * const { serverFns } = await import('./dist/server/sigx-server-fns.js');
 * app.use(createServerFnHandler({ functions: serverFns, guard: requireSession }));
 * app.use(createRequestHandler({ ... }));   // document rendering, unchanged
 * ```
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleServerFnRequest, type ServerFnRequestOptions } from './server/index';
import type { ServerFnContextInit } from './context';

export type NodeRequestHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void
) => Promise<void>;

export interface ServerFnHandlerOptions extends Omit<ServerFnRequestOptions, 'resolve'> {
    /**
     * The prod registry: symbol → lazy import of the wrapped function —
     * the `serverFns` export of the build's `dist/server/sigx-server-fns.js`
     * (explicitly passed, never ambient — the resume-manifest posture).
     */
    functions?: Record<string, () => Promise<unknown>>;
    /** Custom resolution (the dev middleware passes ssrLoadModule here). */
    resolve?(symbol: string): unknown | Promise<unknown>;
    /** URL prefix the handler owns. Default `/_sigx/fn`. */
    base?: string;
}

/**
 * Create the connect-style server-function endpoint. Non-matching URLs call
 * `next()` — mount it beside (before) the document request handler, AFTER
 * any app-wide middleware that must also see RPC calls.
 */
export function createServerFnHandler(options: ServerFnHandlerOptions): NodeRequestHandler {
    const base = options.base ?? '/_sigx/fn';
    const prefix = base.endsWith('/') ? base : base + '/';
    const resolve =
        options.resolve ??
        (async (symbol: string) => {
            const load = options.functions?.[symbol];
            return load ? await load() : null;
        });

    return async function handleFnRequest(req, res, next) {
        if (!req.url?.startsWith(prefix)) {
            if (next) next();
            else {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end('{"error":{"message":"Not found","status":404}}');
            }
            return;
        }
        try {
            const request = toWebRequest(req, res);
            const response = await handleServerFnRequest(request, {
                resolve,
                guard: options.guard,
                origin: options.origin,
                maxBodyBytes: options.maxBodyBytes,
                onError: options.onError,
                timeoutMs: options.timeoutMs
            });
            // Accumulate duplicates (set-cookie!) into arrays — a plain
            // string map would overwrite all but the last value.
            const headers: Record<string, string | string[]> = {};
            response.headers.forEach((value, key) => {
                const existing = headers[key];
                if (existing === undefined) headers[key] = value;
                else if (Array.isArray(existing)) existing.push(value);
                else headers[key] = [existing, value];
            });
            const setCookie = (
                response.headers as { getSetCookie?: () => string[] }
            ).getSetCookie?.();
            if (setCookie && setCookie.length > 0) headers['set-cookie'] = setCookie;
            res.writeHead(response.status, headers);
            if (!response.body) {
                res.end();
                return;
            }
            // Pump instead of buffering: serverStream responses are
            // long-lived NDJSON bodies — buffering would stall progressive
            // delivery (and never finish for long streams). Respect
            // backpressure, and cancel the source on client disconnect (the
            // stream's cancel() returns the server generator).
            const reader = response.body.getReader();
            res.on('close', () => {
                // Fire-and-forget: cancel() rejects if the stream already
                // errored — never let that surface as an unhandled rejection.
                if (!res.writableEnded) void reader.cancel().catch(() => {});
            });
            for (;;) {
                const { value, done } = await reader.read();
                if (done || res.destroyed) break;
                if (!res.write(value)) {
                    // Race drain against close — a client that disconnects
                    // while backpressured never emits 'drain', and an
                    // unraced wait would pin this handler forever.
                    await new Promise<void>((resolve) => {
                        const settle = (): void => {
                            res.off('drain', settle);
                            res.off('close', settle);
                            resolve();
                        };
                        res.once('drain', settle);
                        res.once('close', settle);
                    });
                    if (res.destroyed) break;
                }
            }
            if (!res.destroyed) res.end();
        } catch (err) {
            if (res.headersSent) {
                // Mid-body failure — the status is gone; just drop the socket.
                res.destroy();
                return;
            }
            if (next) {
                next(err);
                return;
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"Internal error","status":500}}');
        }
    };
}

/** Bridge IncomingMessage → WinterCG Request (body streamed, abort wired). */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
    // Behind a TLS-terminating proxy the socket is plaintext but the
    // browser's Origin is https — honor the standard forwarded proto so the
    // same-origin check compares like with like.
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const proto =
        forwarded || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    const host = forwardedHost || (req.headers.host ?? 'localhost');
    const url = `${proto}://${host}${req.url ?? '/'}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
    }

    // The Request's signal — surfaced to handlers as rq.abortSignal — fires
    // when the client goes away before the response is done.
    const controller = new AbortController();
    res.once('close', () => {
        if (!res.writableEnded) controller.abort();
    });

    const method = req.method ?? 'GET';
    const body =
        method === 'GET' || method === 'HEAD'
            ? undefined
            : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);

    return new Request(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        // Required by undici for stream bodies; not yet in lib.dom's RequestInit.
        ...(body ? ({ duplex: 'half' } as unknown as RequestInit) : {})
    });
}

// ---------------------------------------------------------------------------
// Ambient request context for in-process (SSR-time) calls — rfc-server §7 v1.1
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `context` visible to every server function called inside it,
 * however deep (#309).
 *
 * A server function shaped `sessionFrom(rq.request)` works over RPC but
 * throws when the same function is called during SSR, because an in-process
 * call has no request to expose. Wrap the render and it does:
 *
 * ```js
 * import { runWithServerFnContext } from '@sigx/server/node';
 *
 * app.use(async (req, res, next) => {
 *     // Abort when the client goes away: the scope adopts this Request's
 *     // signal, so SSR-time work sees it on rq.abortSignal.
 *     const aborter = new AbortController();
 *     res.once('close', () => {
 *         if (!res.writableEnded) aborter.abort();
 *     });
 *     const request = new Request(
 *         `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`,
 *         { headers: req.headers, signal: aborter.signal }
 *     );
 *     await runWithServerFnContext(request, () => renderHandler(req, res, next));
 * });
 * ```
 *
 * (Built inline on purpose — the handler's own `IncomingMessage` bridge is
 * internal, and a document render needs headers and a URL, not the body.)
 *
 * `AsyncLocalStorage` carries it across every `await` in the render without
 * threading a parameter through user code. The store is installed on first
 * use and read through the `__SIGX_SERVERFN_CONTEXT__` seam
 * (`docs/seams.md`) rather than a module variable — the `.` and `./node`
 * entries are separate dist entries, and in dev the Vite module runner and
 * Node can hold two copies of the same module.
 *
 * **Explicit still wins**: `fn.with({ context })` overrides whatever is
 * ambient, and with neither, `rq.request` keeps throwing its descriptive
 * error rather than returning undefined.
 *
 * **Runtime support.** CALLING this loads `node:async_hooks` (the import is
 * dynamic — importing `@sigx/server/node` itself pulls nothing), so it needs
 * Node, Deno, or workerd with `nodejs_compat`. Runtimes without it use
 * `fn.with({ context })`, which needs no ALS and behaves identically — that
 * is the WinterCG-portable form.
 */
export async function runWithServerFnContext<T>(
    context: ServerFnContextInit,
    fn: () => T | Promise<T>
): Promise<T> {
    const store = await ensureContextStore();
    // No cast: `run` hands back exactly what `fn` returned — a value or a
    // promise — and this function being async settles either into Promise<T>.
    return store.run(context, fn);
}

/** The slice of AsyncLocalStorage this uses — typed here so the entry needs
 *  no `node:async_hooks` types at build time. */
interface ContextStore {
    run<R>(ctx: ServerFnContextInit, fn: () => R): R;
    getStore(): ServerFnContextInit | undefined;
}
let _storePromise: Promise<ContextStore> | undefined;

/**
 * Create the ALS once per process and (re-)stamp the resolver seam on every
 * scope entry.
 *
 * The AsyncLocalStorage is memoized — one store, so nested scopes nest — but
 * the seam is re-asserted each time rather than only on first use: it is a
 * global, and anything may clobber or delete it (a test teardown, another
 * copy of this module, a host that resets globals between requests). The
 * write is a property assignment; re-doing it is cheaper than the class of
 * bug where the store exists but nothing can read it.
 *
 * The import is dynamic so merely loading this entry does not pull
 * `node:async_hooks` on a runtime that lacks it — only calling
 * `runWithServerFnContext` does.
 */
function ensureContextStore(): Promise<ContextStore> {
    _storePromise ??= import('node:async_hooks').then(
        ({ AsyncLocalStorage }) => new AsyncLocalStorage<ServerFnContextInit>()
    );
    return _storePromise.then((als) => {
        (globalThis as {
            __SIGX_SERVERFN_CONTEXT__?: () => ServerFnContextInit | undefined;
        }).__SIGX_SERVERFN_CONTEXT__ = () => als.getStore();
        return als as unknown as ContextStore;
    });
}
