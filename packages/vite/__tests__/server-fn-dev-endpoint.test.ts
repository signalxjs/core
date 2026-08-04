/**
 * @vitest-environment node
 *
 * The dev endpoint `sigxServer()` mounts (#561), driven over a real socket.
 *
 * Every other test in this directory calls plugin hooks and inspects their
 * return values; `configureServer` is only ever handed a `middlewares.use`
 * that captures the handler and throws it away. So the handler the dev
 * middleware BUILDS had never been invoked — which is precisely why the
 * option-forwarding defect #547 fixed in the Node adapter survived one layer
 * up here: `maxUrlBytes`, `onError` and `timeoutMs` could not even be spelled
 * in `SigxServerOptions`, so a cap tuned for production silently did nothing
 * under `vite dev`.
 *
 * The fake dev server hands back the REAL `@sigx/server/node` namespace and a
 * module of REAL wrapped functions, so this exercises the actual endpoint
 * rather than a stand-in.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serverFn, ServerFnError } from '@sigx/server';
import * as serverFnNode from '@sigx/server/node';
import { createServerApp, type ServerApp } from '@sigx/server/server';
import { sigxServer, type SigxServerOptions } from '../src/server-fn';

/** What the fixture module looks like ON DISK — the extractor's input.
 *  `allowAnonymous: true` because the endpoint EXECUTES these under the
 *  fail-closed runtime (rfc-server-v4): with no server app stamped, a bare
 *  fn would 401 before any of the options this file is about could matter. */
const API = `
import { serverFn } from '@sigx/server';

export const read = serverFn({
    allowAnonymous: true,
    cache: { maxAge: 60 },
    handler: async (rq, id) => 'read:' + id
});

export const never = serverFn({
    allowAnonymous: true,
    handler: async () => new Promise(() => {})
});
`;

/** …and the live module the fake \`ssrLoadModule\` resolves it to. */
const liveModule = {
    read: serverFn({
        allowAnonymous: true,
        cache: { maxAge: 60 },
        handler: async (_rq: unknown, id: string) => `read:${id}`
    }),
    never: serverFn({
        allowAnonymous: true,
        handler: async () => new Promise(() => {})
    })
};

interface Mounted {
    origin: string;
    /** Hashed wire symbol for an export of the fixture module. */
    symbol(name: 'read' | 'never'): string;
    /** Everything the plugin sent to the dev logger's `error` — assertable,
     *  never swallowed (a no-op logger hid unexpected logs when debugging). */
    loggerErrors: string[];
    close(): Promise<void>;
}

const mounted: Mounted[] = [];

/**
 * Boot the plugin against a temp project, capture the middleware
 * `configureServer` registers, and serve it from a real `node:http` server.
 */
async function mount(
    options: SigxServerOptions = {},
    modules: Record<string, unknown> = {}
): Promise<Mounted> {
    const root = mkdtempSync(join(tmpdir(), 'sigx-dev-endpoint-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/api.server.ts'), API);

    // requireGuards off: this file is about option forwarding, not the guard
    // gate (which has its own coverage in server-fn-plugin.test.ts).
    const plugin = sigxServer({ requireGuards: false, ...options }) as any;
    plugin.configResolved({ root, command: 'serve' });

    const registry = plugin.load(plugin.resolveId('virtual:sigx-server-fns')) as string;

    let middleware:
        | ((req: unknown, res: unknown, next: (err?: unknown) => void) => void)
        | undefined;
    const loggerErrors: string[] = [];
    plugin.configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
        watcher: { add: () => {} },
        config: {
            logger: {
                warn: () => {},
                error: (msg: unknown) => loggerErrors.push(String(msg))
            }
        },
        ssrLoadModule: (id: string) => {
            if (id === '@sigx/server/node') return Promise.resolve(serverFnNode);
            const mod = modules[id] ?? liveModule;
            // An Error VALUE in the module map models a module that fails to
            // evaluate (mid-edit syntax error): ssrLoadModule rejects.
            return mod instanceof Error ? Promise.reject(mod) : Promise.resolve(mod);
        }
    });
    if (!middleware) throw new Error('configureServer mounted no middleware');

    const server: Server = createServer((req, res) => {
        middleware!(req, res, (err?: unknown) => {
            res.statusCode = err ? 500 : 404;
            res.end(err ? 'error' : 'fallthrough');
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const handle: Mounted = {
        origin: `http://127.0.0.1:${port}`,
        loggerErrors,
        symbol(name) {
            const match = new RegExp(`\\["(${name}_fn_[0-9a-f]{8})"\\]`).exec(registry);
            if (!match) throw new Error(`no symbol for ${name} in the registry`);
            return match[1];
        },
        close: async () => {
            server.close();
            await once(server, 'close');
            rmSync(root, { recursive: true, force: true });
        }
    };
    mounted.push(handle);
    return handle;
}

afterEach(async () => {
    for (const handle of mounted.splice(0)) await handle.close();
});

describe('sigxServer — the dev endpoint forwards every endpoint option (#561)', () => {
    it('serves a server function (the control — a later 414 must not pass for the wrong reason)', async () => {
        const dev = await mount();
        const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('read')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: dev.origin },
            body: JSON.stringify({ args: ['p1'] })
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 'read:p1' });
    });

    it('forwards maxUrlBytes — a GET read over the cap is a 414, not the 8 KiB default', async () => {
        const dev = await mount({ maxUrlBytes: 64 });
        const res = await fetch(
            `${dev.origin}/_sigx/fn/${dev.symbol('read')}?a0=${'x'.repeat(300)}`
        );
        expect(res.status).toBe(414);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Query string too large', status: 414 }
        });
    });

    it('forwards maxResponseBytes — an over-cap response is a 500, not delivered (#571)', async () => {
        const onError = vi.fn();
        const dev = await mount({ maxResponseBytes: 16, onError });
        const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('read')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: dev.origin },
            body: JSON.stringify({ args: ['a-long-enough-input-to-cross-sixteen-bytes'] })
        });
        expect(res.status).toBe(500);
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toContain('maxResponseBytes');
    });

    it('forwards timeoutMs and onError — a hung handler 504s and reports once', async () => {
        const onError = vi.fn();
        const dev = await mount({ timeoutMs: 25, onError });
        const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('never')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: dev.origin },
            body: JSON.stringify({ args: [] })
        });
        expect(res.status).toBe(504);
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toContain('timed out after 25ms');
        expect((onError.mock.calls[0][1] as { name: string }).name).toBe('never');
    });

    it('still forwards the options that already worked — a cross-origin POST is 403', async () => {
        const dev = await mount();
        const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('read')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
            body: JSON.stringify({ args: ['p1'] })
        });
        expect(res.status).toBe(403);
    });

    it('a request outside the base falls through to the next middleware', async () => {
        const dev = await mount();
        const res = await fetch(`${dev.origin}/not-a-server-fn`);
        expect(res.status).toBe(404);
        await expect(res.text()).resolves.toBe('fallthrough');
    });

    it('the serverApp module is loaded and its pipeline enforced on a dev RPC (rfc-server-v4 §3.4)', async () => {
        // The specifier resolves to a module that calls createServerApp at
        // module scope — the eager configureServer load evaluates it, the
        // evaluation stamps the seam, and the endpoint's prelude runs the
        // app's middleware for this dev request (replaces the pre-v4 dev
        // `guard` specifier).
        let app: ServerApp | undefined;
        const serverAppModule = {
            get app(): ServerApp {
                app ??= createServerApp({
                    middleware: [
                        () => {
                            throw new ServerFnError(429, 'dev limited');
                        }
                    ],
                    authenticate: () => ({ id: 'dev' })
                });
                return app;
            }
        };
        try {
            // Touch the getter, as a real side-effect module would at eval.
            void serverAppModule.app;
            const dev = await mount(
                { serverApp: '/src/server-app.ts' },
                { '/src/server-app.ts': serverAppModule }
            );
            const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('read')}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: dev.origin },
                body: JSON.stringify({ args: ['p1'] })
            });
            expect(res.status).toBe(429);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'dev limited', status: 429 }
            });
        } finally {
            // The stamp is process-global — release it so the rest of this
            // file keeps its no-app posture.
            app?.dispose();
        }
    });

    it('a BROKEN serverApp module is logged, never a crashed request — the fallback is fail-closed', async () => {
        // Mid-edit the module can be a syntax error (ssrLoadModule rejects);
        // the per-request load must log and continue so the runtime denies
        // fail-closed (nothing stamped here) instead of aborting the RPC
        // through next(err).
        const dev = await mount(
            { serverApp: '/src/server-app.ts' },
            { '/src/server-app.ts': new Error('mid-edit syntax error') }
        );
        const res = await fetch(`${dev.origin}/_sigx/fn/${dev.symbol('read')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: dev.origin },
            body: JSON.stringify({ args: ['p1'] })
        });
        // SERVED, not crashed — the load failure was caught and logged, and
        // the request went on through createServerFnHandler. This fixture's
        // fns are `allowAnonymous`, so with nothing stamped they still run;
        // a protected fn would deny 401 fail-closed instead (the pipeline
        // pins in packages/server/__tests__/app-pipeline.test.ts). Either
        // way the response is the RUNTIME's — never the harness's 500
        // 'error' body from next(err).
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 'read:p1' });
        // And LOGGED — both the eager configureServer load and the
        // per-request load report the broken module.
        expect(dev.loggerErrors.length).toBeGreaterThanOrEqual(1);
        for (const entry of dev.loggerErrors) {
            expect(entry).toContain('/src/server-app.ts');
            expect(entry).toContain('mid-edit syntax error');
        }
    });
});
