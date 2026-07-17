/**
 * @sigx/server-renderer/node
 *
 * The Node-only streaming surface (rfc-ssr-platform §2.3). Everything that
 * touches `node:stream` lives here — `@sigx/server-renderer` and
 * `@sigx/server-renderer/server` are WinterCG-clean and run on edge runtimes
 * unchanged.
 *
 * These are thin Readable wrappers over the runtime-agnostic chunk
 * primitives (`renderChunks` / `renderDocumentChunks`); for a plugin-driven
 * instance, wrap its chunks yourself:
 *
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * import { toNodeStream } from '@sigx/server-renderer/node';
 *
 * const ssr = createSSR().use(islandsPlugin());
 * toNodeStream(ssr.renderChunks(<App />)).pipe(res);
 * ```
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JSXElement, App } from 'sigx';
import { createSSR } from './ssr';
import { defaultSSR } from './server/render-api';
import { defaultIsBot } from './server/bot';
import type { SSRContext, SSRContextOptions } from './server/context';
import type { DocumentOptions } from './server/document';
import type { SSRResponse } from './response';

/**
 * Wrap an async chunk source (an `AsyncIterable<string>` such as
 * `ssr.renderChunks(...)`, or a Web `ReadableStream<string>`) in a Node.js
 * Readable.
 *
 * `objectMode` defaults to true (each HTML string is one chunk). Pass
 * `{ objectMode: false }` when backpressure should be measured in bytes —
 * the right choice for whole documents piped to slow clients.
 */
export function toNodeStream(
    source: AsyncIterable<string> | ReadableStream<string>,
    options: { objectMode?: boolean } = {}
): Readable {
    const iterable: AsyncIterable<string> =
        Symbol.asyncIterator in source
            ? (source as AsyncIterable<string>)
            : webStreamIterator(source as ReadableStream<string>);
    return Readable.from(iterable, { objectMode: options.objectMode ?? true });
}

async function* webStreamIterator(stream: ReadableStream<string>): AsyncGenerator<string> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Render JSX element or App to a Node.js Readable stream.
 *
 * Faster than `renderToStream()` on Node.js because it bypasses WebStream
 * overhead entirely. Recommended for Express, Fastify, H3, and other
 * Node.js HTTP frameworks.
 *
 * @example
 * ```tsx
 * import { renderToNodeStream } from '@sigx/server-renderer/node';
 *
 * const stream = renderToNodeStream(<App />);
 * stream.pipe(res);
 * ```
 */
export function renderToNodeStream(
    input: JSXElement | App,
    context?: SSRContextOptions | SSRContext
): Readable {
    return toNodeStream(defaultSSR.renderChunks(input, context));
}

/**
 * Stream a complete HTML document as a Node.js Readable.
 * `shell` settles before any byte is produced — await it, set the status
 * code, then pipe.
 *
 * @example
 * ```tsx
 * import { renderDocumentToNodeStream } from '@sigx/server-renderer/node';
 *
 * const { stream, shell } = renderDocumentToNodeStream(app, { template });
 * let head; try { head = await shell; } catch { return res.status(500).send(errorPage); }
 * if (head.redirect) return res.redirect(head.redirect.status, head.redirect.location);
 * res.status(head.status).set(head.headers).setHeader('content-type', 'text/html');
 * stream.pipe(res);
 * ```
 */
export function renderDocumentToNodeStream(
    input: JSXElement | App,
    options: DocumentOptions
): { stream: Readable; shell: Promise<SSRResponse> } {
    const { chunks, shell } = defaultSSR.renderDocumentChunks(input, options);
    return {
        // Non-object mode: backpressure/highWaterMark measured in BYTES —
        // in object mode a few large HTML strings buffer far more memory
        // than intended under slow clients.
        stream: toNodeStream(chunks, { objectMode: false }),
        shell
    };
}

// ============================================================================
// createRequestHandler — the copyable production handler (rfc-ssr-platform
// §3.3). Explicitly NOT a meta-framework: no file-system routing, no
// conventions beyond the public seams — just the dispatch every hand-written
// server repeats (bot → blocking document; everyone else → shell-first
// streaming with the shell as the status/redirect decision point).
// ============================================================================

export interface RequestHandlerOptions {
    /**
     * The document template containing the outlet marker — a string for the
     * common prebuilt case, or a per-request resolver (the dev handler in
     * `@sigx/vite` passes `vite.transformIndexHtml` through here).
     */
    template: string | ((url: string, req: IncomingMessage) => string | Promise<string>);

    /**
     * Per-request app factory: build a FRESH app for this URL — per-request
     * provides (router, cache) are what make concurrent SSR safe. May also
     * return a bare element for provider-less pages.
     */
    app: (url: string, req: IncomingMessage) => App | JSXElement | Promise<App | JSXElement>;

    /**
     * Document options for the render (assets, onError, renderError, outlet,
     * serializeState, …) — static, or resolved per request. `template` and
     * `mode` are owned by the handler.
     */
    document?:
        | Omit<DocumentOptions, 'template' | 'mode'>
        | ((url: string, req: IncomingMessage) => Omit<DocumentOptions, 'template' | 'mode'>);

    /**
     * Crawler detection: bots get `mode: 'blocking'` (complete inline
     * content, no replacement scripts). Default: a common crawler UA regex.
     * Pass `() => false` to always stream.
     */
    isBot?: (userAgent: string, req: IncomingMessage) => boolean;

    /**
     * The SSR instance to render with (plugins!). Default: a plugin-less
     * shared instance.
     */
    ssr?: Pick<ReturnType<typeof createSSR>, 'renderDocumentChunks'>;
}

export type NodeRequestHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void
) => Promise<void>;

/**
 * Create a connect-style production request handler over the public
 * document API.
 *
 * ```ts
 * import { createRequestHandler } from '@sigx/server-renderer/node';
 *
 * const handler = createRequestHandler({
 *     template,
 *     app: (url) => makeApp(url),           // fresh app per request
 *     document: { assets }                  // manifest preloads etc.
 * });
 * server.use(handler);                      // Express / connect / node:http
 * ```
 *
 * Dispatch: crawlers get a blocking document; everyone else gets shell-first
 * streaming. The shell resolution (`useResponse`'s `{ status, headers,
 * redirect }`) writes the response head before the first byte; a redirect
 * sends the location and no body. A shell failure calls `next(err)` when
 * available, else a minimal 500.
 */
export function createRequestHandler(options: RequestHandlerOptions): NodeRequestHandler {
    const ssr = options.ssr ?? defaultSSR;
    const isBot = options.isBot ?? defaultIsBot;

    return async function handleRequest(req, res, next) {
        const url = req.url ?? '/';
        try {
            const [template, input] = await Promise.all([
                typeof options.template === 'function'
                    ? options.template(url, req)
                    : options.template,
                options.app(url, req)
            ]);
            const docOptions =
                typeof options.document === 'function'
                    ? options.document(url, req)
                    : options.document;
            const mode = isBot(String(req.headers['user-agent'] ?? ''), req)
                ? ('blocking' as const)
                : ('stream' as const);

            const { chunks, shell } = ssr.renderDocumentChunks(input, {
                ...docOptions,
                template,
                mode
            });

            // The shell is the status/redirect decision point (§2.1).
            const head = await shell;

            if (head.redirect) {
                res.writeHead(head.redirect.status, { location: head.redirect.location });
                res.end();
                await chunks.return?.(undefined); // release the (empty) generator
                return;
            }

            res.writeHead(head.status, {
                'content-type': 'text/html; charset=utf-8',
                ...head.headers
            });

            const body = toNodeStream(chunks, { objectMode: false });
            body.pipe(res);
            await new Promise<void>((resolve) => {
                body.on('end', resolve);
                body.on('error', (err) => {
                    // Mid-stream failure after the head was sent: the document
                    // generator already routed it to onError; end the response
                    // visibly truncated.
                    if (__DEV__) {
                        console.error('[createRequestHandler] stream error:', err);
                    }
                    res.end();
                    resolve();
                });
            });
        } catch (err) {
            // Shell (or app-factory) failure — no byte has been written yet.
            if (next) {
                next(err);
                return;
            }
            res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><title>500</title><h1>Internal Server Error</h1>');
        }
    };
}
