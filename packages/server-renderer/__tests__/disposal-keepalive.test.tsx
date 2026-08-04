/**
 * The motivating pin of rfc-server-v3 §2.6 (phase 5, #571): a STREAMED edge
 * response disposes request values at END-OF-BODY, not at the shell.
 *
 * Integration, not simulation: importing `@sigx/server` stamps the REAL
 * `__SIGX_SERVERFN_SCOPE__` (with `keepAlive`), `createFetchHandler` opens
 * that scope over a real AsyncLocalStorage, and the `useData` fetcher calls
 * a real `serverFn` whose `perRequest` value registers a disposer.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { component, useData } from 'sigx';
import { createFetchHandler } from '../src/server/fetch-handler';
import { createRequestHandler } from '../src/node';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { perRequest, serverFn } from '@sigx/server';
import { stubServerApp } from '@sigx/server/testing';
// The scope seam is stamped by the SERVER entries' import graph (scope.ts,
// "stamped at IMPORT") — an edge deployment always has one of them loaded.
import '@sigx/server/server';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

// The fixtures are DIRECT-form fns (nowhere to declare `allowAnonymous`),
// and the fail-closed runtime (rfc-server-v4) would 401 them before any
// disposal machinery ran — this file is about disposal, not access, so an
// authenticated app makes the pipeline transparent.
let restoreApp: () => void;
beforeEach(() => {
    restoreApp = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
});
afterEach(() => {
    restoreApp();
    vi.restoreAllMocks();
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const eventually = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i++) await tick();
    expect(check()).toBe(true);
};

/** A page whose data fetcher — settling AFTER the shell — reads a
 *  per-request value that registered a disposer. */
function disposablePage(key: string) {
    let disposed = false;
    const value = perRequest((_rq, onDispose) => {
        onDispose(() => void (disposed = true));
        return 'session-data';
    });
    const fetchIt = serverFn(async (rq) => value(rq));
    const Page = component(() => {
        const data = useData(key, async () => {
            await new Promise((r) => setTimeout(r, 5)); // after the shell
            return fetchIt();
        });
        return () => <main>{(data.value as string) ?? 'loading'}</main>;
    });
    return { Page, isDisposed: () => disposed };
}

describe('createFetchHandler — disposal waits for the body (F-A)', () => {
    it('NOT disposed at the shell; disposed after the body is fully read', async () => {
        const { Page, isDisposed } = disposablePage('edge:body');
        const handler = createFetchHandler({ template: TEMPLATE, app: () => <Page /> });
        const response = await handler(new Request('https://shop.test/orders'));
        // The handler (and the scope's run()) has settled — the shell. The
        // fetcher is still resolving into the stream: disposing HERE is the
        // exact wrong-number bug §2.6 declined to ship.
        await tick();
        await tick();
        expect(isDisposed()).toBe(false);
        const html = await response.text();
        expect(html).toContain('session-data');
        await eventually(isDisposed);
    });

    it('client cancel mid-body disposes — a straggling fetcher included', async () => {
        // After the cancel, the in-flight useData fetcher still settles and
        // registers its disposer on the already-disposed store; the sticky
        // `disposed` mark runs it immediately (with a dev warning) instead
        // of parking it forever.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { Page, isDisposed } = disposablePage('edge:cancel');
        const handler = createFetchHandler({ template: TEMPLATE, app: () => <Page /> });
        const response = await handler(new Request('https://shop.test/orders'));
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        await eventually(isDisposed);
    });

    it('a shell error disposes at the scope settle — no body, no keepAlive', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const probe = serverFn(async (rq) => value(rq));
        const handler = createFetchHandler({
            template: TEMPLATE,
            app: async () => {
                await probe(); // computes the value inside the scope…
                throw new Error('app factory blew up'); // …then the shell fails
            }
        });
        const response = await handler(new Request('https://shop.test/'));
        expect(response.status).toBe(500);
        await eventually(() => disposed);
    });
});

describe('createRequestHandler — the Node twin needs no keepAlive', () => {
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

    it('disposes after the handler resolves — it awaits body end inside the scope', async () => {
        const { Page, isDisposed } = disposablePage('node:body');
        const handler = createRequestHandler({ template: TEMPLATE, app: () => <Page /> });
        const res = new MockRes();
        await handler(
            { url: '/orders', headers: { 'user-agent': 'Mozilla/5.0' } } as unknown as IncomingMessage,
            res as unknown as ServerResponse
        );
        expect(res.body).toContain('session-data');
        await eventually(isDisposed);
    });
});
