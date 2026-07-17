/**
 * createFetchHandler — the WinterCG sibling of `createRequestHandler`
 * (rfc-deploy §2). One fetch handler finishes the runtime story for every
 * platform that speaks `(Request) => Promise<Response>`: Cloudflare Workers,
 * Deno Deploy, Bun, Vercel Edge, Netlify. Same dispatch decisions as the
 * Node handler, re-expressed in Web primitives — bot → blocking document;
 * everyone else → shell-first streaming with the shell as the
 * status/redirect decision point.
 *
 * Explicitly NOT a meta-framework, and NOT an all-in-one server: static
 * assets and the server-fn endpoint are sibling composition in the
 * user-owned platform entry (static → server functions → document render).
 * No sigx handler serves static files, ever.
 */

import type { JSXElement, App } from 'sigx';
import type { SSRInstance } from '../ssr';
import type { DocumentOptions } from './document';
import { defaultSSR } from './render-api';
import { defaultIsBot } from './bot';
import { chunksToBytes } from './bytes';

export interface FetchHandlerOptions<TPlatform = unknown> {
    /**
     * The document template containing the outlet marker — a prebuilt string
     * for the common case, or a per-request resolver.
     */
    template:
        | string
        | ((url: string, request: Request, platform: TPlatform) => string | Promise<string>);

    /**
     * Per-request app factory: build a FRESH app for this URL — per-request
     * provides (router, cache) are what make concurrent SSR safe. The same
     * frozen contract as the Node and dev handlers, so one `entry-server`
     * serves all three; `request` and `platform` ride along for apps that
     * need headers or platform bindings during render.
     */
    app: (
        url: string,
        request: Request,
        platform: TPlatform
    ) => App | JSXElement | Promise<App | JSXElement>;

    /**
     * Document options for the render (assets, onError, renderError, outlet,
     * serializeState, …) — static, or resolved per request. `template` and
     * `mode` are owned by the handler.
     */
    document?:
        | Omit<DocumentOptions, 'template' | 'mode'>
        | ((
              url: string,
              request: Request,
              platform: TPlatform
          ) => Omit<DocumentOptions, 'template' | 'mode'>);

    /**
     * Crawler detection: bots get `mode: 'blocking'` (complete inline
     * content, no replacement scripts). Default: the shared crawler UA
     * regex (`defaultIsBot`). Pass `() => false` to always stream.
     */
    isBot?: (userAgent: string, request: Request) => boolean;

    /**
     * The SSR instance to render with (plugins!). Default: a plugin-less
     * shared instance.
     */
    ssr?: Pick<SSRInstance, 'renderDocumentChunks'>;
}

export type FetchHandler<TPlatform = unknown> = (
    request: Request,
    // Optional for the default/`undefined`-admitting instantiations
    // (Deno/Bun pass nothing); REQUIRED once the generic is instantiated
    // with real bindings — omitting Cloudflare's `{ env, ctx }` is a
    // compile error, and the callbacks' `platform: TPlatform` stays sound.
    ...platform: undefined extends TPlatform ? [platform?: TPlatform] : [platform: TPlatform]
) => Promise<Response>;

/**
 * Create a fetch-shaped production request handler over the public document
 * API.
 *
 * ```ts
 * import { createFetchHandler } from '@sigx/server-renderer/server';
 *
 * const handler = createFetchHandler({
 *     template,
 *     app: (url) => createApp(url),          // fresh app per request
 *     document: { assets }                   // manifest preloads etc.
 * });
 *
 * export default {
 *     fetch: (request: Request) => handler(request)
 * };
 * ```
 *
 * The second argument is the platform context (e.g. Cloudflare's
 * `{ env, ctx }`) — opaque to sigx, threaded verbatim into every callback.
 * It is optional under the default `TPlatform = unknown`; instantiating the
 * generic with real bindings makes it required, so the callbacks' typed
 * `platform` can never silently be `undefined`.
 * A shell failure produces a minimal 500; there is no `next()` in the fetch
 * world — a custom error page is a wrapper around the returned handler.
 */
export function createFetchHandler<TPlatform = unknown>(
    options: FetchHandlerOptions<TPlatform>
): FetchHandler<TPlatform> {
    const ssr = options.ssr ?? defaultSSR;
    const isBot = options.isBot ?? defaultIsBot;

    return async function handleFetch(request, ...rest) {
        const parsed = new URL(request.url);
        // Path + query, matching the Node/dev handlers' `req.url` — one
        // `createApp(url)` entry contract across all three.
        const url = parsed.pathname + parsed.search;
        // Internal-only cast: the FetchHandler tuple makes `platform`
        // required whenever TPlatform doesn't admit undefined.
        const p = rest[0] as TPlatform;
        try {
            const [template, input] = await Promise.all([
                typeof options.template === 'function'
                    ? options.template(url, request, p)
                    : options.template,
                options.app(url, request, p)
            ]);
            const docOptions =
                typeof options.document === 'function'
                    ? options.document(url, request, p)
                    : options.document;
            const mode = isBot(request.headers.get('user-agent') ?? '', request)
                ? ('blocking' as const)
                : ('stream' as const);

            const { chunks, shell } = ssr.renderDocumentChunks(input, {
                ...docOptions,
                template,
                mode
            });

            // The shell resolution (`useResponse`'s { status, headers,
            // redirect }) decides the response head before the first byte.
            const head = await shell;

            if (head.redirect) {
                // Release the (empty) generator without awaiting — the
                // redirect is decided; its Response must not hinge on (or be
                // converted to a 500 by) the release settling.
                void chunks.return?.(undefined);
                return new Response(null, {
                    status: head.redirect.status,
                    headers: { location: head.redirect.location }
                });
            }

            return new Response(chunksToBytes(chunks), {
                status: head.status,
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    ...head.headers
                }
            });
        } catch (err) {
            // Shell (or app-factory) failure — no byte written yet.
            if (__DEV__) {
                console.error('[createFetchHandler] shell error:', err);
            }
            return new Response(
                '<!doctype html><title>500</title><h1>Internal Server Error</h1>',
                { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }
            );
        }
    };
}
