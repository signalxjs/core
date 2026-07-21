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
     * `{ env, ctx }` from a dev binding proxy. Forwarded verbatim as the
     * THIRD argument to both the entry factory and a function-form
     * `document`, matching `createFetchHandler`'s `app(url, request,
     * platform)`. The second argument is the request (#304); existing
     * `createApp(url)` factories ignore both.
     */
    platform?: unknown;

    /**
     * Inline the SSR module graph's CSS into the dev document's `<head>`
     * (default: true). Without it the dev server streams a fully-rendered
     * but UNSTYLED document — in dev, Vite serves JS-imported CSS as a
     * module that injects a `<style>` at runtime, so the browser paints the
     * whole page unstyled until the client entry executes. Production is
     * unaffected (the built template carries real `<link>` tags).
     *
     * The styles are emitted as `<style data-vite-dev-id="…">`, the shape
     * Vite's client adopts on boot and HMR-replaces in place — no duplicated
     * rules, CSS HMR untouched. Set `false` if your template already ships a
     * stylesheet link of its own.
     */
    devStyles?: boolean;
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

// ============================================================================
// collectDevStyles — the dev server's answer to the build manifest
// ============================================================================

/** A CSS request: known extension, optionally followed by a query. */
const DEV_CSS_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/**
 * Queries that make a CSS import something OTHER than a stylesheet — `?url`
 * and `?raw` yield a string, `?worker` a constructor. Inlining those would
 * apply rules the app deliberately did not apply.
 */
const DEV_CSS_SKIP_RE = /[?&](?:url|raw|inline|worker|sharedworker)(?:[&=]|$)/;

/** Minimal structural view of a module-graph node (both Vite graph flavours). */
interface DevModuleNode {
    id?: string | null;
    url?: string;
    type?: string;
    importedModules?: Iterable<DevModuleNode>;
}

/** Minimal structural view of the pieces of the graph/environment we touch. */
interface DevModuleGraph {
    getModuleByUrl?(url: string, ssr?: boolean): Promise<DevModuleNode | undefined> | DevModuleNode | undefined;
}

interface DevServerInternals {
    environments?: {
        ssr?: { moduleGraph?: DevModuleGraph };
        client?: { transformRequest?(url: string): Promise<{ code?: string } | null> };
    };
    moduleGraph?: DevModuleGraph;
    transformRequest?(url: string, options?: { ssr?: boolean }): Promise<{ code?: string } | null>;
}

function escapeAttrValue(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** `</style` is the ONLY sequence that can close the element early. */
function escapeStyleText(css: string): string {
    return css.replace(/<\/(style)/gi, '<\\/$1');
}

/** The client stamps `data-vite-dev-id` with the posix-normalized module id. */
function normalizeDevId(id: string): string {
    return id.replace(/\\/g, '/');
}

/** Append `direct` so Vite's css plugin returns the stylesheet, not the HMR module. */
function directUrl(url: string): string {
    return url + (url.includes('?') ? '&' : '?') + 'direct';
}

/**
 * Collect the CSS reachable from the SSR entry as inline `<style>` tags
 * (rfc-ssr-platform §3.1's dev counterpart to `collectAssets`).
 *
 * In dev there is no manifest and no extracted stylesheet: Vite serves
 * JS-imported CSS as a module that calls `updateStyle()` at runtime, so a
 * server-rendered document has NO styles in its head and paints unstyled
 * until the client entry executes. Walking the SSR module graph gives us the
 * same information the build manifest would.
 *
 * Emitted as `<style data-vite-dev-id="<id>">` rather than a `<link>`: Vite's
 * client adopts pre-existing style tags carrying that attribute into its
 * sheet map on boot and rewrites their text in place on HMR. A `<link>` would
 * be registered too, but `updateStyle()` bails early for links — CSS HMR
 * would silently stop working.
 *
 * Fails soft: styling is an enhancement here, and no CSS is worth a dev server
 * that will not serve.
 */
async function collectDevStyles(
    vite: ViteDevServer,
    entry: string,
    loadEntry: () => Promise<unknown>
): Promise<string> {
    try {
        // The SSR module graph is populated by loading the entry — and this
        // runs from the `template` callback, which can be invoked BEFORE the
        // `app` callback that loads it. Without warming here the first
        // request after every server start would still paint unstyled.
        // `loadEntry` is the request's memoized load, so this is free.
        await loadEntry();

        const server = vite as unknown as DevServerInternals;
        const graph = server.environments?.ssr?.moduleGraph ?? server.moduleGraph;
        if (!graph?.getModuleByUrl) return '';

        const root = await graph.getModuleByUrl(entry, true);
        if (!root) return '';

        // Depth-first in import order — cascade order is load-bearing, and a
        // Set preserves insertion order. CSS nodes are leaves: Vite resolves
        // `@import` into the parent's own `?direct` output, so descending
        // into them would emit the same rules twice.
        const seenNodes = new Set<DevModuleNode>();
        const seenIds = new Set<string>();
        const sheets: { id: string; url: string }[] = [];

        const visit = (mod: DevModuleNode | undefined): void => {
            if (!mod || seenNodes.has(mod)) return;
            seenNodes.add(mod);
            const id = mod.id ?? mod.url;
            if (id && (mod.type === 'css' || DEV_CSS_RE.test(id))) {
                if (DEV_CSS_SKIP_RE.test(id)) return;
                const devId = normalizeDevId(id);
                if (seenIds.has(devId)) return;
                seenIds.add(devId);
                sheets.push({ id: devId, url: mod.url ?? id });
                return;
            }
            for (const dep of mod.importedModules ?? []) visit(dep);
        };
        visit(root);
        if (sheets.length === 0) return '';

        // The CLIENT environment's transform is the one that yields a
        // stylesheet: the SSR environment has no CSS pipeline (its module for
        // a `.css` file exports nothing, and `?direct` there fails outright
        // as the bundler tries to parse CSS as JS).
        //
        // Requesting `?direct` registers that url in the client module graph,
        // so an edit later emits an extra `css-update` for it alongside the
        // real `js-update`. Benign: the client's css-update path looks for a
        // matching `<link>`, finds none, and returns — the `js-update` on the
        // module itself is what rewrites the adopted style tag. Verified
        // against a live dev server.
        const transform = server.environments?.client?.transformRequest
            ? (url: string) => server.environments!.client!.transformRequest!(url)
            : server.transformRequest
              ? (url: string) => server.transformRequest!(url, { ssr: false })
              : null;
        if (!transform) return '';

        let out = '';
        for (const sheet of sheets) {
            const code = (await transform(directUrl(sheet.url)))?.code?.trim();
            if (!code) continue;
            out += `<style type="text/css" data-vite-dev-id="${escapeAttrValue(sheet.id)}">${escapeStyleText(code)}</style>`;
        }
        return out;
    } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                `[sigx:ssr] could not inline dev styles for "${entry}" — the page will ` +
                `paint unstyled until the client entry runs. Pass devStyles: false to silence.`,
                err
            );
        }
        return '';
    }
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

            // ONE entry load per request, shared by the two callbacks below.
            // The style walk needs the SSR module graph populated and can run
            // before the app callback; memoizing here keeps that ordering
            // requirement from costing a second load.
            let entryLoad: Promise<Record<string, unknown>> | undefined;
            const loadEntry = () =>
                (entryLoad ??= vite.ssrLoadModule(options.entry) as Promise<Record<string, unknown>>);

            const inner = createRequestHandler({
                template: async (url) => {
                    const raw = await readFile(templatePath, 'utf-8');
                    const html = await vite.transformIndexHtml(url, raw);
                    if (options.devStyles === false) return html;
                    // AFTER transformIndexHtml, so /@vite/client still leads
                    // the head. Sliced rather than String.replace'd: CSS is
                    // full of `$`, which a string replacement would expand.
                    const styles = await collectDevStyles(vite, options.entry, loadEntry);
                    if (!styles) return html;
                    // `</head>` normally; `</body>` for a head-less template.
                    // NEVER prepend — that would put markup ahead of the
                    // doctype and drop the browser into quirks mode.
                    const close = (() => {
                        const head = html.indexOf('</head>');
                        if (head !== -1) return head;
                        const body = html.indexOf('</body>');
                        return body !== -1 ? body : html.length;
                    })();
                    return html.slice(0, close) + styles + html.slice(close);
                },
                // `devReq` is the second argument on purpose: it matches what
                // BOTH production handlers pass — `createRequestHandler`'s
                // `app(url, req)` and `createFetchHandler`'s
                // `app(url, request, platform)`. Dev used to pass `platform`
                // second and drop the request entirely, so a factory reading a
                // session cookie rendered logged-out in dev and correct in
                // prod (#304). The sibling `document` callback below already
                // forwarded it; only `app` had diverged.
                app: async (url, devReq) => {
                    const mod = await loadEntry();
                    const factory = mod[entryExport];
                    if (typeof factory !== 'function') {
                        throw new Error(
                            `[sigx:ssr] entry module "${options.entry}" does not export ` +
                            `"${entryExport}(url)" — export a per-request app factory ` +
                            `(see the router SSR contract).`
                        );
                    }
                    return factory(url, devReq, options.platform);
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
