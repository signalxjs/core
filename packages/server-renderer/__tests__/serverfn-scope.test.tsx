/**
 * The document handlers open the server-function request scope
 * (`__SIGX_SERVERFN_SCOPE__` — rfc-server §7 v1.1, #309), so an in-process
 * server-function call made anywhere in a render sees the real request.
 *
 * The runner here is a REAL AsyncLocalStorage, not a spy: the property that
 * matters is that a `useData` fetcher — which resolves long after the handler
 * returned to its caller, while chunks are still being pumped — is still
 * inside the scope. Only a real store can demonstrate that.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { component, useData } from 'sigx';
import { createRequestHandler } from '../src/node';
import { createFetchHandler } from '../src/server/fetch-handler';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

interface Seam {
    run<T>(source: unknown, fn: () => T | Promise<T>): Promise<T>;
}
const seamHolder = globalThis as { __SIGX_SERVERFN_SCOPE__?: Seam };

/** Install a runner and report what the render saw, exactly like the real one. */
function installRunner(): { storage: AsyncLocalStorage<unknown>; sources: unknown[] } {
    const storage = new AsyncLocalStorage<unknown>();
    const sources: unknown[] = [];
    seamHolder.__SIGX_SERVERFN_SCOPE__ = {
        // Async like the real one (@sigx/server awaits a dynamic
        // node:async_hooks import before the store exists).
        async run(source, fn) {
            sources.push(source);
            return storage.run(source, fn);
        }
    };
    return { storage, sources };
}

afterEach(() => {
    delete seamHolder.__SIGX_SERVERFN_SCOPE__;
});

/** A page whose async data fetcher records the scope it resolved in. */
function scopeProbe(storage?: AsyncLocalStorage<unknown>, key = 'probe') {
    const seen: { store?: unknown } = {};
    const Page = component(() => {
        const data = useData(key, async () => {
            // Resolves after the shell — while the handler streams.
            await new Promise((r) => setTimeout(r, 5));
            seen.store = storage?.getStore();
            return 'ok';
        });
        return () => <main>{(data.value as string) ?? 'loading'}</main>;
    });
    return { Page, seen };
}

class MockRes extends Writable {
    status = 0;
    body = '';
    writeHead(status: number): this {
        this.status = status;
        return this;
    }
    override _write(chunk: unknown, _enc: string, cb: () => void): void {
        this.body += String(chunk);
        cb();
    }
    override end(...args: unknown[]): this {
        if (typeof args[0] === 'string' || Buffer.isBuffer(args[0])) this.body += String(args[0]);
        return super.end() as unknown as this;
    }
}

const mockReq = (url: string): IncomingMessage =>
    ({ url, headers: { 'user-agent': 'Mozilla/5.0' } }) as unknown as IncomingMessage;

describe('createRequestHandler', () => {
    it('runs the render — streaming included — inside the request scope', async () => {
        const { storage, sources } = installRunner();
        const { Page, seen } = scopeProbe(storage, 'node:probe');
        const req = mockReq('/orders');
        const res = new MockRes();

        const handler = createRequestHandler({ template: TEMPLATE, app: () => <Page /> });
        await handler(req, res as unknown as ServerResponse);

        expect(sources).toEqual([req]);
        // The fetcher settled inside the scope, not after it closed.
        expect(seen.store).toBe(req);
        expect(res.body).toContain('ok');
    });

    it('renders unchanged when no runner is registered', async () => {
        const { Page, seen } = scopeProbe(undefined, 'node:norunner');
        const res = new MockRes();

        const handler = createRequestHandler({ template: TEMPLATE, app: () => <Page /> });
        await handler(mockReq('/'), res as unknown as ServerResponse);

        expect(res.status).toBe(200);
        expect(res.body).toContain('ok');
        expect(seen.store).toBeUndefined();
    });
});

describe('createFetchHandler', () => {
    it('runs the render — streaming included — inside the request scope', async () => {
        const { storage, sources } = installRunner();
        const { Page, seen } = scopeProbe(storage, 'fetch:probe');
        const request = new Request('https://shop.test/orders');

        const handler = createFetchHandler({ template: TEMPLATE, app: () => <Page /> });
        const response = await handler(request);
        const html = await response.text();

        expect(sources).toEqual([request]);
        expect(seen.store).toBe(request);
        expect(html).toContain('ok');
    });

    it('renders unchanged when no runner is registered', async () => {
        const { Page } = scopeProbe(undefined, 'fetch:norunner');
        const handler = createFetchHandler({ template: TEMPLATE, app: () => <Page /> });
        const response = await handler(new Request('https://shop.test/'));

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('ok');
    });
});
