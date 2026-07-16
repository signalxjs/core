/**
 * createRequestHandler (rfc-ssr-platform §3.3) — the copyable production
 * dispatch: bot → blocking document, everyone else → shell-first streaming;
 * the shell writes the response head (status/headers/redirect from
 * useResponse); shell failures go to next()/500.
 */

import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { component, useData } from 'sigx';
import { useResponse } from '../src/index';
import { createRequestHandler } from '../src/node';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

class MockRes extends Writable {
    status = 0;
    headers: Record<string, string> = {};
    body = '';
    ended = false;

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
        this.ended = true;
        return super.end() as unknown as this;
    }
}

function mockReq(url: string, userAgent = 'Mozilla/5.0'): IncomingMessage {
    return { url, headers: { 'user-agent': userAgent } } as unknown as IncomingMessage;
}

async function run(handler: ReturnType<typeof createRequestHandler>, req: IncomingMessage, next?: (e?: unknown) => void) {
    const res = new MockRes();
    await handler(req, res as unknown as ServerResponse, next);
    return res;
}

const Page = component(() => {
    const data = useData('rh:data', async () => {
        await new Promise(r => setTimeout(r, 5));
        return { n: 9 };
    });
    return () => <main class="pg">{data.value ? (data.value as any).n : 'loading'}</main>;
}, { name: 'Page' });

describe('createRequestHandler — dispatch', () => {
    it('streams for browsers: 200 + content-type, placeholder shell then replacement', async () => {
        const handler = createRequestHandler({ template: TEMPLATE, app: () => (Page as any)({}) });
        const res = await run(handler, mockReq('/'));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain('data-async-placeholder');
        expect(res.body).toContain('$SIGX_REPLACE(');
        expect(res.body).toContain('9');
        expect(res.body).toContain('sigx:ready');
        expect(res.ended).toBe(true);
    });

    it('blocks for crawlers: complete inline content, no replacement machinery', async () => {
        const handler = createRequestHandler({ template: TEMPLATE, app: () => (Page as any)({}) });
        const res = await run(handler, mockReq('/', 'Googlebot/2.1 (+http://www.google.com/bot.html)'));
        expect(res.status).toBe(200);
        expect(res.body).toContain('>9<');
        expect(res.body).not.toContain('data-async-placeholder');
        expect(res.body).not.toContain('$SIGX_REPLACE(');
    });

    it('writes useResponse status and headers before the body', async () => {
        const NotFound = component(() => {
            useResponse().status(404).header('x-robots-tag', 'noindex');
            return () => <h1>nope</h1>;
        }, { name: 'NotFound' });
        const handler = createRequestHandler({ template: TEMPLATE, app: () => (NotFound as any)({}) });
        const res = await run(handler, mockReq('/missing'));
        expect(res.status).toBe(404);
        expect(res.headers['x-robots-tag']).toBe('noindex');
        expect(res.body).toContain('<h1>nope</h1>');
    });

    it('sends a redirect with no body', async () => {
        const Guard = component(() => {
            useResponse().redirect('/login', 302);
            return () => <p>never</p>;
        }, { name: 'Guard' });
        const handler = createRequestHandler({ template: TEMPLATE, app: () => (Guard as any)({}) });
        const res = await run(handler, mockReq('/private'));
        expect(res.status).toBe(302);
        expect(res.headers['location']).toBe('/login');
        expect(res.body).toBe('');
        expect(res.ended).toBe(true);
    });

    it('routes shell failures to next(); falls back to a 500 page without next', async () => {
        const handler = createRequestHandler({
            template: '<html><body>no outlet</body></html>',
            app: () => (Page as any)({})
        });
        const next = vi.fn();
        await run(handler, mockReq('/'), next);
        expect(next).toHaveBeenCalledWith(expect.any(Error));

        const res = await run(handler, mockReq('/'));
        expect(res.status).toBe(500);
        expect(res.body).toContain('Internal Server Error');
    });

    it('resolves per-request template and document options', async () => {
        const handler = createRequestHandler({
            template: (url) => TEMPLATE.replace('<head>', `<head><meta name="u" content="${url}">`),
            app: () => (Page as any)({}),
            document: (url) => ({ assets: { modulepreload: [`/route${url}.js`] } }),
            isBot: () => true
        });
        const res = await run(handler, mockReq('/about'));
        expect(res.body).toContain('<meta name="u" content="/about">');
        expect(res.body).toContain('<link rel="modulepreload" href="/route/about.js">');
    });
});
