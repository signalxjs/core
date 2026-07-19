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
import { createDevRequestHandler } from '../src/ssr';

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
        // entry for the former.
        ssrLoadModule: vi.fn(async (id: string) =>
            id === '@sigx/server-renderer/node'
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
            .filter((c: string[]) => c[0] === '@sigx/server-renderer/node').length;
        expect(rendererLoads).toBeGreaterThan(0);
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
            createApp: (_url: string, p: unknown) => {
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

    it('is a no-op when the graph holds no CSS (inline-<style> templates)', async () => {
        const { vite } = styledVite(mod(ENTRY, [mod('/src/App.tsx')]), {});
        const handler = await createDevRequestHandler(vite, { entry: ENTRY });
        const res = await run(handler, '/');
        expect(res.body).not.toContain('data-vite-dev-id');
        expect(res.body).toContain('dev page');
    });

    it('omitting platform stays byte-compatible (undefined second arg)', async () => {
        const args: unknown[][] = [];
        const vite = mockVite({
            createApp: (...a: unknown[]) => {
                args.push(a);
                return defineApp((Home as any)({}));
            }
        });
        const handler = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
        await run(handler, '/');
        expect(args[0][1]).toBeUndefined();
    });
});
