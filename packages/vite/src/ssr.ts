/**
 * @sigx/vite/ssr — the development half of the request handler
 * (rfc-ssr-platform §3.3): a Vite-powered composition of
 * `createRequestHandler` from `@sigx/server-renderer/node`, so the dev
 * server is `createServer` plus one handler instead of sixty hand-written
 * lines of `transformIndexHtml` + `ssrLoadModule` + error plumbing.
 *
 * ```ts
 * import { createServer as createViteServer } from 'vite';
 * import { createDevRequestHandler } from '@sigx/vite/ssr';
 *
 * const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom' });
 * app.use(vite.middlewares);
 * app.use(await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' }));
 * ```
 *
 * The entry-module contract: export `createApp(url: string)` returning a
 * FRESH per-request app (per-request provides — router, cache — are what
 * make concurrent SSR safe). The same factory feeds the production handler.
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { ViteDevServer } from 'vite';

/** Structural view of the pieces of the prod handler options we forward. */
interface ForwardedHandlerOptions {
    document?: unknown;
    isBot?: unknown;
    ssr?: unknown;
}

export interface DevRequestHandlerOptions extends ForwardedHandlerOptions {
    /**
     * The SSR entry module (Vite-root-relative, e.g. '/src/entry-server.tsx').
     * Loaded per request through `ssrLoadModule` so edits apply immediately.
     */
    entry: string;

    /**
     * The exported per-request app factory on the entry module:
     * `(url: string) => App | Promise<App>`. Default: 'createApp'.
     */
    entryExport?: string;

    /** Template path relative to the Vite root. Default: 'index.html'. */
    template?: string;
}

type NodeRequestHandler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next?: (err?: unknown) => void
) => Promise<void>;

/**
 * Create the development request handler: per-request template via
 * `transformIndexHtml`, per-request entry via `ssrLoadModule` (fresh module
 * graph on edit), SSR stack traces mapped back to source, and the same
 * bot/stream/status dispatch as production.
 */
export async function createDevRequestHandler(
    vite: ViteDevServer,
    options: DevRequestHandlerOptions
): Promise<NodeRequestHandler> {
    // Lazy import: @sigx/server-renderer is required only when the SSR
    // handler is actually used, not by every @sigx/vite consumer.
    const { createRequestHandler } = await import('@sigx/server-renderer/node');

    const templatePath = resolvePath(vite.config.root, options.template ?? 'index.html');
    const entryExport = options.entryExport ?? 'createApp';

    const inner = createRequestHandler({
        template: async (url) => {
            const raw = await readFile(templatePath, 'utf-8');
            return vite.transformIndexHtml(url, raw);
        },
        app: async (url) => {
            const mod = await vite.ssrLoadModule(options.entry);
            const factory = mod[entryExport];
            if (typeof factory !== 'function') {
                throw new Error(
                    `[sigx:ssr] entry module "${options.entry}" does not export ` +
                    `"${entryExport}(url)" — export a per-request app factory ` +
                    `(see the router SSR contract).`
                );
            }
            return factory(url);
        },
        document: options.document as never,
        isBot: options.isBot as never,
        ssr: options.ssr as never
    });

    return async function devHandler(req, res, next) {
        await inner(req, res, (err?: unknown) => {
            // Map SSR stack frames back to source before surfacing.
            if (err instanceof Error) {
                vite.ssrFixStacktrace(err);
            }
            if (next) next(err);
            else {
                res.statusCode = 500;
                res.end('<!doctype html><title>500</title><h1>Internal Server Error</h1>');
            }
        });
    };
}
