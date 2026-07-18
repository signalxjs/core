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
