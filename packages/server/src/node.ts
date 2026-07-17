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
                maxBodyBytes: options.maxBodyBytes
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
                if (!res.writableEnded) void reader.cancel();
            });
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!res.write(value)) {
                    await new Promise<void>((resolve) => res.once('drain', () => resolve()));
                }
            }
            res.end();
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
