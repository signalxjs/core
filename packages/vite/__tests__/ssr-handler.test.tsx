/**
 * @vitest-environment node
 *
 * createDevRequestHandler (rfc-ssr-platform §3.3, dev half): per-request
 * transformIndexHtml + ssrLoadModule composition over the production
 * dispatch, entry-contract validation, and ssrFixStacktrace on failures.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { component, defineApp } from 'sigx';
import { createDevRequestHandler, SSR_NODE_VIRTUAL_ID } from '../src/ssr';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sigx-ssr-dev-'));
    writeFileSync(join(root, 'index.html'), TEMPLATE);
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

class MockRes extends Writable {
    status = 0;
    headers: Record<string, string> = {};
    body = '';

    writeHead(status: number, headers?: Record<string, string>): this {
        this.status = status;
        Object.assign(this.headers, headers);
        return this;
    }

    override _write(chunk: any, _enc: string, cb: () => void): void {
        this.body += chunk.toString();
        cb();
    }

    override end(...args: any[]): this {
        if (typeof args[0] === 'string' || Buffer.isBuffer(args[0])) {
            this.body += args[0].toString();
        }
        return super.end() as unknown as this;
    }
}

const Home = component(() => () => <main class="dev">dev page</main>, { name: 'Home' });

function mockVite(entryModule: Record<string, unknown>): ViteDevServer {
    return {
        config: { root },
        transformIndexHtml: vi.fn(async (_url: string, html: string) =>
            html.replace('<head>', '<head><script type="module" src="/@vite/client"></script>')),
        // The handler loads BOTH the renderer and the entry through the
        // module runner (one module graph); the mock serves the real node
        // entry for the former, which the handler asks for through the
        // `virtual:sigx-ssr-node` shim the `sigx()` plugin resolves (#425).
        ssrLoadModule: vi.fn(async (id: string) =>
            id === SSR_NODE_VIRTUAL_ID || id === '@sigx/server-renderer/node'
                ? import('@sigx/server-renderer/node')
                : entryModule),
        ssrFixStacktrace: vi.fn()
    } as unknown as ViteDevServer;
}

/** A module-graph node shaped like Vite's (id + url + importedModules Set). */
function mod(url: string, imports: any[] = [], type?: string) {
    return { id: url.startsWith('/') ? '/abs' + url : url, url, type, importedModules: new Set(imports) };
}

/**
 * Extend a mock with the SSR module graph + client transform that
 * `collectDevStyles` walks. `css` maps a served url to its stylesheet text.
 */
function withGraph(
    vite: ViteDevServer,
    entry: string,
    root: any,
    css: Record<string, string>,
    transformImpl?: (url: string) => Promise<{ code?: string } | null>
) {
    const transformRequest = vi.fn(transformImpl ?? (async (url: string) => {
        const bare = url.replace(/[?&]direct\b/, '').replace(/\?$/, '');
        return bare in css ? { code: css[bare] } : null;
    }));
    Object.assign(vite as any, {
        environments: {
            ssr: {
                moduleGraph: {
                    getModuleByUrl: vi.fn(async (url: string) => (url === entry ? root : undefined))
                }
            },
            client: { transformRequest }
        }
    });
    return transformRequest;
}

async function run(handler: Awaited<ReturnType<typeof createDevRequestHandler>>, url: string, next?: (e?: unknown) => void) {
    const res = new MockRes();
    await handler(
        { url, headers: { 'user-agent': 'Mozilla/5.0' } } as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        next
    );
    return res;
}

describe('createDevRequestHandler', () => {
    it('serves the transformed template with the rendered app', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        const res = await run(handler, '/');
        expect(res.status).toBe(200);
        expect(res.body).toContain('/@vite/client');          // transformIndexHtml applied
        expect(res.body).toContain('<main class="dev">dev page</main>');
        expect(vite.ssrLoadModule).toHaveBeenCalledWith('/src/entry-server.tsx');
    });

    it('loads the entry per request (fresh module graph on edit)', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/a');
        await run(handler, '/b');
        const entryLoads = (vite.ssrLoadModule as any).mock.calls
            .filter((c: string[]) => c[0] === '/src/entry-server.tsx').length;
        expect(entryLoads).toBe(2);
    });

    it('loads the RENDERER through the module runner (one graph with the app — #207)', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/');
        // A Node-resolved renderer would carry its own DI token identities
        // and never see the app's provides ("useRouter() called without a
        // Router provided" in real dev servers).
        const rendererLoads = (vite.ssrLoadModule as any).mock.calls
            .filter((c: string[]) => c[0] === SSR_NODE_VIRTUAL_ID).length;
        expect(rendererLoads).toBeGreaterThan(0);
    });

    it('asks for the renderer through the virtual shim, never the bare package (#425)', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/');
        // Naming the package as the ROOT of an ssrLoadModule call forces the
        // runner to inline it whatever `ssr.external` says, while the app's
        // own @sigx imports externalize — two module graphs, two sets of DI
        // tokens, and app-carried SSR plugins silently dropped. Behind the
        // shim's `export *` the same external/noExternal decision reaches
        // both.
        const ids = (vite.ssrLoadModule as any).mock.calls.map((c: string[]) => c[0]);
        expect(ids).toContain(SSR_NODE_VIRTUAL_ID);
        expect(ids).not.toContain('@sigx/server-renderer/node');
    });

    it('falls back to the bare package when the shim does not resolve (no sigx() plugin)', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        // A dev server without the sigx() plugin has nobody to resolve the
        // virtual — and no ssr.noExternal either, so one graph is not at
        // stake and the direct specifier is correct.
        (vite.ssrLoadModule as any).mockImplementation(async (id: string) => {
            if (id === SSR_NODE_VIRTUAL_ID) throw new Error(`Failed to resolve import "${id}"`);
            if (id === '@sigx/server-renderer/node') return import('@sigx/server-renderer/node');
            return { createApp: () => defineApp((Home as any)({})) };
        });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        const res = await run(handler, '/');
        expect(res.status).toBe(200);
        expect(res.body).toContain('<main class="dev">dev page</main>');
    });

    it('supports a custom entry export name', async () => {
        const vite = mockVite({ makeApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, {
            entry: '/src/entry-server.tsx',
            entryExport: 'makeApp'
        });
        const res = await run(handler, '/');
        expect(res.body).toContain('dev page');
    });

    it('rejects an entry without the contract export, mapping the stack', async () => {
        const vite = mockVite({ somethingElse: 1 });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        const next = vi.fn();
        await run(handler, '/', next);
        expect(next).toHaveBeenCalledWith(expect.any(Error));
        expect((next.mock.calls[0][0] as Error).message).toContain('createApp');
        expect(vite.ssrFixStacktrace).toHaveBeenCalled();
    });

    it('threads the platform option to the entry factory and function-form document (rfc-deploy §4.6)', async () => {
        const platform = { env: { KV: 'binding' } };
        const seen: unknown[] = [];
        const vite = mockVite({
            // THIRD argument (#304) — the second is the request, matching
            // `createFetchHandler`'s `app(url, request, platform)`. The
            // `document` callback below always used that shape; the entry
            // factory used to take platform second and never see the request.
            createApp: (_url: string, _req: unknown, p: unknown) => {
                seen.push(p);
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, {
            entry: '/src/entry-server.tsx',
            platform,
            document: (_url: string, _req: unknown, p: unknown) => {
                seen.push(p);
                return {};
            }
        });
        const res = await run(handler, '/');
        expect(res.body).toContain('dev page');
        expect(seen).toHaveLength(2);
        for (const p of seen) expect(p).toBe(platform);
    });

    // ------------------------------------------------------------------
    // Dev styles (#359): dev has no manifest, and Vite serves JS-imported
    // CSS as a runtime-injecting module — so without this the SSR head is
    // empty of styles and the whole document paints unstyled.
    // ------------------------------------------------------------------

    const ENTRY = '/src/entry-server.tsx';

    function styledVite(root: any, css: Record<string, string>, impl?: any) {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const transformRequest = withGraph(vite, ENTRY, root, css, impl);
        return { vite, transformRequest };
    }

    it('inlines the SSR graph CSS into <head> as an adoptable style tag', async () => {
        const { vite } = styledVite(
            mod(ENTRY, [mod('/src/App.tsx', [mod('/src/styles.css')])]),
            { '/src/styles.css': '.btn{color:red}' }
        );
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).toContain('.btn{color:red}');
        // The attribute is what makes Vite ADOPT this tag instead of adding a
        // second one — and it must carry the module id, not the url.
        expect(res.body).toContain('data-vite-dev-id="/abs/src/styles.css"');
        // Before </head>, after /@vite/client.
        const head = res.body.slice(0, res.body.indexOf('</head>'));
        expect(head).toContain('.btn{color:red}');
        expect(head.indexOf('/@vite/client')).toBeLessThan(head.indexOf('.btn{color:red}'));
    });

    it('preserves import order and collapses duplicates', async () => {
        const shared = mod('/src/base.css');
        const { vite } = styledVite(
            mod(ENTRY, [
                mod('/src/a.tsx', [shared, mod('/src/a.css')]),
                mod('/src/b.tsx', [shared, mod('/src/b.css')])
            ]),
            { '/src/base.css': '.base{}', '/src/a.css': '.a{}', '/src/b.css': '.b{}' }
        );
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        // Cascade order is load-bearing.
        expect(res.body.indexOf('.base{}')).toBeLessThan(res.body.indexOf('.a{}'));
        expect(res.body.indexOf('.a{}')).toBeLessThan(res.body.indexOf('.b{}'));
        expect(res.body.match(/\.base\{\}/g)).toHaveLength(1);
    });

    it('skips ?url / ?raw imports — those are strings, not applied styles', async () => {
        const { vite } = styledVite(
            mod(ENTRY, [mod('/src/theme.css?url'), mod('/src/real.css')]),
            { '/src/theme.css': '.nope{}', '/src/real.css': '.yes{}' }
        );
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).toContain('.yes{}');
        expect(res.body).not.toContain('.nope{}');
    });

    it('escapes a </style> sequence so the element cannot be closed early', async () => {
        const { vite } = styledVite(mod(ENTRY, [mod('/src/x.css')]), {
            '/src/x.css': '.a{content:"</style><script>bad()</script>"}'
        });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).toContain('<\\/style');
        // `</style` is the only sequence an HTML parser honours inside a
        // style element — with it escaped, the `<script>` payload stays inert
        // CSS text. Assert the element opens once and closes once, so the
        // payload provably never escapes into markup.
        expect(res.body.match(/<style\b/g)).toHaveLength(1);
        expect(res.body.match(/<\/style>/g)).toHaveLength(1);
    });

    it('warms the graph before walking it (first request must not flash)', async () => {
        const { vite } = styledVite(mod(ENTRY, [mod('/src/styles.css')]), {
            '/src/styles.css': '.warm{}'
        });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        // The template callback can run before the app callback loads the
        // entry, so collectDevStyles must load it itself — otherwise the
        // graph is empty on every cold start and the flash simply moves.
        const res = await run(handler, '/');
        expect(res.body).toContain('.warm{}');
    });

    it('serves an unstyled page rather than a 500 when the transform throws', async () => {
        const { vite } = styledVite(mod(ENTRY, [mod('/src/styles.css')]), {}, async () => {
            throw new Error('postcss exploded');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        warn.mockRestore();
        expect(res.status).toBe(200);
        expect(res.body).toContain('dev page');
    });

    it('devStyles: false opts out (template already ships its own <link>)', async () => {
        const { vite, transformRequest } = styledVite(mod(ENTRY, [mod('/src/styles.css')]), {
            '/src/styles.css': '.btn{}'
        });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY, devStyles: false });
        const res = await run(handler, '/');
        expect(res.body).not.toContain('.btn{}');
        expect(transformRequest).not.toHaveBeenCalled();
    });

    it('never emits styles before the doctype (no quirks mode) on a head-less template', async () => {
        // A template without </head> must still keep <!doctype html> first —
        // prepending would drop the browser into quirks mode.
        const headless = join(root, 'headless.html');
        writeFileSync(headless, '<!doctype html><html><body><div id="app"><!--ssr-outlet--></div></body></html>');
        const { vite } = styledVite(mod(ENTRY, [mod('/src/styles.css')]), {
            '/src/styles.css': '.q{}'
        });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY, template: 'headless.html' });
        const res = await run(handler, '/');
        expect(res.body.startsWith('<!doctype html>')).toBe(true);
        expect(res.body).toContain('.q{}');
        // Placed before </body>, not after the document.
        expect(res.body.indexOf('.q{}')).toBeLessThan(res.body.indexOf('</body>'));
    });

    it('falls back to the legacy moduleGraph / transformRequest (pre-environments Vite)', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const root = mod(ENTRY, [mod('/src/legacy.css')]);
        // No `environments` at all — only the flat server-level API.
        Object.assign(vite as any, {
            moduleGraph: {
                getModuleByUrl: vi.fn(async (url: string, ssr?: boolean) =>
                    url === ENTRY && ssr === true ? root : undefined)
            },
            transformRequest: vi.fn(async (url: string, opts?: { ssr?: boolean }) =>
                url.includes('/src/legacy.css') && opts?.ssr === false ? { code: '.legacy{}' } : null)
        });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).toContain('.legacy{}');
        expect(res.body).toContain('data-vite-dev-id="/abs/src/legacy.css"');
    });

    it('serves the page when the Vite build exposes no module graph at all', async () => {
        const vite = mockVite({ createApp: () => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.status).toBe(200);
        expect(res.body).toContain('dev page');
        expect(res.body).not.toContain('data-vite-dev-id');
    });

    it('is a no-op when the graph holds no CSS (inline-<style> templates)', async () => {
        const { vite } = styledVite(mod(ENTRY, [mod('/src/App.tsx')]), {});
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).not.toContain('data-vite-dev-id');
        expect(res.body).toContain('dev page');
    });

    it('omitting platform leaves the THIRD argument undefined', async () => {
        const args: unknown[][] = [];
        const vite = mockVite({
            createApp: (...a: unknown[]) => {
                args.push(a);
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/');
        // [0] url, [1] req (always present), [2] platform — absent here.
        expect(args[0][1]).toBeDefined();
        expect(args[0][2]).toBeUndefined();
    });
});

describe('createDevRequestHandler — entry factory arguments (#304)', () => {
    it('forwards the request as the second argument, like both prod handlers', async () => {
        // The bug: dev called factory(url, platform) and dropped the request,
        // so a factory reading a session cookie rendered logged-out in dev and
        // correct in prod. `createRequestHandler` passes app(url, req);
        // `createFetchHandler` passes app(url, request, platform).
        let seen: { url?: string; req?: any; platform?: unknown } = {};
        const vite = mockVite({
            createApp: (url: string, req: any, platform: unknown) => {
                seen = { url, req, platform };
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/dashboard');

        expect(seen.url).toBe('/dashboard');
        expect(seen.req).toBeDefined();
        expect(seen.req.headers['user-agent']).toBe('Mozilla/5.0');
    });

    it('lets a factory read a cookie off the request — the reported failure', async () => {
        let user: string | undefined;
        const vite = mockVite({
            createApp: (_url: string, req: any) => {
                user = /session=(\w+)/.exec(req?.headers?.cookie ?? '')?.[1];
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        const res = new MockRes();
        await handler(
            {
                url: '/',
                headers: { 'user-agent': 'Mozilla/5.0', cookie: 'session=alice' }
            } as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            undefined
        );
        expect(user).toBe('alice');
    });

    it('passes platform THIRD, matching createFetchHandler', async () => {
        const platform = { env: { KV: 'binding' } };
        let seen: unknown;
        const vite = mockVite({
            createApp: (_url: string, _req: any, p: unknown) => {
                seen = p;
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, {
            entry: '/src/entry-server.tsx',
            platform
        });
        await run(handler, '/');
        expect(seen).toBe(platform);
    });

    it('leaves a one-argument factory working', async () => {
        const vite = mockVite({ createApp: (url: string) => defineApp((Home as any)({})) });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        const res = await run(handler, '/');
        expect(res.status).toBe(200);
        expect(res.body).toContain('<main class="dev">dev page</main>');
    });
});
