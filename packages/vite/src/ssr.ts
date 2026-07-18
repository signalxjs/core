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

    /**
     * Opaque platform context (rfc-deploy §4.6) — e.g. Cloudflare's
     * `{ env, ctx }` from a dev binding proxy. Forwarded verbatim: to the
     * entry factory as its second argument (existing `createApp(url)`
     * factories ignore it) and to a function-form `document` as its third —
     * matching the fetch handler's callback shapes.
     */
    platform?: unknown;
}

type NodeRequestHandler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next?: (err?: unknown) => void
) => Promise<void>;

// ============================================================================
// collectAssets — Vite client manifest → DocumentOptions.assets
// ============================================================================

/** One chunk entry of Vite's client build manifest (`.vite/manifest.json`). */
export interface ViteManifestChunk {
    file: string;
    src?: string;
    isEntry?: boolean;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

/** The `DocumentOptions.assets` shape from `@sigx/server-renderer`. */
export interface CollectedAssets {
    modulepreload: string[];
    stylesheets: string[];
}

/**
 * Resolve manifest entries into the `DocumentOptions.assets` shape
 * (rfc-ssr-platform §3.1): each entry's chunk plus its transitive STATIC
 * imports become `modulepreload` URLs; every visited chunk's CSS becomes a
 * stylesheet link. Dynamic imports are deliberately excluded — those are the
 * lazy boundaries, preloaded per boundary record by `renderDocument` itself.
 *
 * ```ts
 * const manifest = JSON.parse(readFileSync('dist/client/.vite/manifest.json', 'utf-8'));
 * const assets = collectAssets(manifest, ['src/entry-client.tsx']);
 * renderDocument(app, { template, assets });
 * ```
 *
 * @param entries - manifest keys (source-relative ids, e.g. 'src/entry-client.tsx')
 * @param base - public base path prefixed to every URL. Default '/'.
 */
export function collectAssets(
    manifest: ViteManifest,
    entries: string[],
    base = '/'
): CollectedAssets {
    const modulepreload: string[] = [];
    const stylesheets: string[] = [];
    const seenChunks = new Set<string>();
    const seenUrls = new Set<string>();
    const prefix = base.endsWith('/') ? base : base + '/';

    const push = (list: string[], file: string) => {
        const url = prefix + file;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        list.push(url);
    };

    const visit = (id: string) => {
        if (seenChunks.has(id)) return;
        seenChunks.add(id);
        const chunk = manifest[id];
        if (!chunk) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`[sigx:ssr] collectAssets: "${id}" is not in the manifest — skipped.`);
            }
            return;
        }
        push(modulepreload, chunk.file);
        for (const css of chunk.css ?? []) {
            push(stylesheets, css);
        }
        for (const dep of chunk.imports ?? []) {
            visit(dep);
        }
    };

    for (const entry of entries) {
        visit(entry);
    }

    return { modulepreload, stylesheets };
}

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
    const templatePath = resolvePath(vite.config.root, options.template ?? 'index.html');
    const entryExport = options.entryExport ?? 'createApp';

    // The renderer must live in the SAME module graph as the app: the entry
    // loads through Vite's SSR module runner (where the plugin's
    // ssr.noExternal keeps the whole @sigx family), so the handler's
    // renderer has to come through the runner too — a Node-resolved copy
    // would carry its own DI token identities and never see the app's
    // provides. When the family IS externalized, the runner resolves to
    // Node's instances anyway, so this is consistent in both setups.
    async function loadHandlerFactory(): Promise<typeof import('@sigx/server-renderer/node')> {
        return (await vite.ssrLoadModule('@sigx/server-renderer/node')) as unknown as
            typeof import('@sigx/server-renderer/node');
    }
    // Fail fast at startup if the peer is missing.
    await loadHandlerFactory();

    return async function devHandler(req, res, next) {
        const forward = (err?: unknown) => {
            // Map SSR stack frames back to source before surfacing.
            if (err instanceof Error) {
                vite.ssrFixStacktrace(err);
            }
            if (next) next(err);
            else {
                res.statusCode = 500;
                res.end('<!doctype html><title>500</title><h1>Internal Server Error</h1>');
            }
        };

        try {
            // Per request through the runner: module-graph invalidations
            // (edits to app OR framework source) apply on the next request.
            const { createRequestHandler } = await loadHandlerFactory();
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
                    return factory(url, options.platform);
                },
                document: (typeof options.document === 'function'
                    ? (url: string, devReq: unknown) =>
                          (options.document as (u: string, r: unknown, p: unknown) => unknown)(
                              url,
                              devReq,
                              options.platform
                          )
                    : options.document) as never,
                isBot: options.isBot as never,
                ssr: options.ssr as never
            });
            await inner(req, res, forward);
        } catch (err) {
            forward(err);
        }
    };
}
