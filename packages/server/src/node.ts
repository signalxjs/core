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
 * app.use(createServerFnHandler({ functions: serverFns }));
 * app.use(createRequestHandler({ ... }));   // document rendering, unchanged
 * ```
 *
 * App-wide policy — middleware, authentication, the default authorization —
 * lives in `createServerApp` (rfc-server-v4), not in this handler's options:
 * the pipeline runs identically for requests served here and for in-process
 * (SSR-time) calls made while the document handler below renders.
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleServerFnRequest, type ServerFnRequestOptions } from './server/index';
import { DEFAULT_FN_BASE, fnPathPrefix } from './fn-url-decode';
import type { ServerFnContextInit } from './context';
import { runInScope } from './scope';

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
    const base = options.base ?? DEFAULT_FN_BASE;
    const prefix = fnPathPrefix(base);
    const resolve =
        options.resolve ??
        (async (symbol: string) => {
            // Own-property + callable checks (#555): `functions` is a
            // plain-object registry in the wild, and an inherited lookup
            // ("__proto__", "constructor") must be an unknown symbol — a
            // structured 404 — not a TypeError out of Object.prototype.
            // (hasOwnProperty.call, not Object.hasOwn: the package builds
            // against the ES2020 lib.)
            const fns = options.functions;
            const load =
                fns !== undefined && Object.prototype.hasOwnProperty.call(fns, symbol)
                    ? fns[symbol]
                    : undefined;
            return typeof load === 'function' ? await load() : null;
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
            // Forwarded by SPREAD, deliberately: this options type EXTENDS
            // ServerFnRequestOptions, so a hand-written allow-list has to be
            // kept in sync with an interface it inherits from and nothing
            // enforces that. `maxUrlBytes` was dropped that way and sat inert
            // from #354 to #545 — it type-checked and did nothing. `resolve`
            // and `base` are overridden with the resolved/normalized values;
            // `functions` rides along inert (the endpoint reads only `resolve`).
            const response = await handleServerFnRequest(request, {
                ...options,
                resolve,
                base
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
 * Usually you do not call this at all: `createRequestHandler` and
 * `createFetchHandler` open a scope around every render through the
 * `__SIGX_SERVERFN_SCOPE__` seam, so an app that mounts either handler has
 * ambient context already. Call it directly for renders sigx does not own, or
 * to supply a request with your own abort wiring, as above.
 *
 * `AsyncLocalStorage` carries the request across every `await` in the render
 * without threading a parameter through user code. The store is installed on
 * first use and read through the `__SIGX_SERVERFN_CONTEXT__` seam
 * (`docs/seams.md`) rather than a module variable — the `.` and `./node`
 * entries are separate dist entries, and in dev the Vite module runner and
 * Node can hold two copies of the same module.
 *
 * **Explicit still wins**: `fn.with({ context })` overrides whatever is
 * ambient, and with neither, `rq.request` keeps throwing its descriptive
 * error rather than returning undefined.
 *
 * **Nesting merges** (rfc-server-v3 §2.7, #495). Wrapping a render that opens
 * its own scope — which `createRequestHandler` does — is the point of the
 * recipe above, so a pre-seed like
 * `runWithServerFnContext({ request, locals: { user } }, …)` is carried
 * through: the inner scope's fields win where supplied, and the enclosing
 * `locals` stays the request store. "Same request" is same URL + method
 * (protocol excluded, so a TLS-terminating proxy does not split it); anything
 * else gets its own store, with a once-per-process `__DEV__` notice naming
 * both. To isolate a nested render deliberately — a subrequest on behalf of a
 * different principal — hand the inner scope its own `locals`. Simplest of
 * all: pre-seed with `{ locals }` alone and no request, which makes no claim
 * about which request it is and always merges.
 *
 * **Runtime support.** CALLING this loads `node:async_hooks` (the import is
 * dynamic — importing this entry pulls nothing), so ambient context needs
 * Node, Deno, or workerd with `nodejs_compat`. Where it is missing, `fn` runs
 * UNSCOPED rather than throwing (a missing compatibility flag must not 500 a
 * site) and in-process calls keep the detached context; `fn.with({ context })`
 * needs no ALS and behaves identically — that is the WinterCG-portable form.
 */
export async function runWithServerFnContext<T>(
    context: ServerFnContextInit,
    fn: () => T | Promise<T>
): Promise<T> {
    return runInScope(context, fn);
}
