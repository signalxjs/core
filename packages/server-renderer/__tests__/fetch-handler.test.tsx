/**
 * createFetchHandler (rfc-deploy §2) — the WinterCG sibling of
 * createRequestHandler: same dispatch decisions, Web primitives. Real
 * Request/Response, no mocks.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { component, useData } from 'sigx';
import { useResponse, createSSR } from '../src/index';
import { createFetchHandler } from '../src/server/fetch-handler';
import type { SSRInstance } from '../src/ssr';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

const Page = component(() => {
    const data = useData('fh:data', async () => {
        await new Promise(r => setTimeout(r, 5));
        return { n: 9 };
    });
    return () => <main class="pg">{data.value ? (data.value as any).n : 'loading'}</main>;
}, { name: 'Page' });

/** Wrap a real SSR instance, recording whether the chunk generator was released. */
function trackingSSR() {
    const real = createSSR();
    const state = { returned: false };
    const ssr: Pick<SSRInstance, 'renderDocumentChunks'> = {
        renderDocumentChunks(input, options) {
            const { chunks, shell } = real.renderDocumentChunks(input, options);
            const wrapped: AsyncGenerator<string> = {
                next: (...args) => chunks.next(...args),
                return: (value) => {
                    state.returned = true;
                    return chunks.return(value as undefined);
                },
                throw: (err) => chunks.throw(err),
                [Symbol.asyncIterator]() {
                    return this;
                },
                async [Symbol.asyncDispose]() {
                    await this.return(undefined);
                }
            };
            return { chunks: wrapped, shell };
        }
    };
    return { ssr, state };
}

describe('createFetchHandler — dispatch', () => {
    it('streams for browsers: 200 + content-type, placeholder shell then replacement', async () => {
        const handler = createFetchHandler({ template: TEMPLATE, app: () => (Page as any)({}) });
        const res = await handler(new Request('http://test.local/'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const body = await res.text();
        expect(body).toContain('data-async-placeholder');
        expect(body).toContain('$SIGX_REPLACE(');
        expect(body).toContain('9');
        expect(body).toContain('sigx:ready');
    });

    it('blocks for crawlers: complete inline content, no replacement machinery', async () => {
        const handler = createFetchHandler({ template: TEMPLATE, app: () => (Page as any)({}) });
        const res = await handler(
            new Request('http://test.local/', {
                headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
            })
        );
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('>9<');
        expect(body).not.toContain('data-async-placeholder');
        expect(body).not.toContain('$SIGX_REPLACE(');
    });

    it('merges useResponse status and headers onto the Response', async () => {
        const NotFound = component(() => {
            useResponse().status(404).header('x-robots-tag', 'noindex');
            return () => <h1>nope</h1>;
        }, { name: 'NotFound' });
        const handler = createFetchHandler({ template: TEMPLATE, app: () => (NotFound as any)({}) });
        const res = await handler(new Request('http://test.local/missing'));
        expect(res.status).toBe(404);
        expect(res.headers.get('x-robots-tag')).toBe('noindex');
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(await res.text()).toContain('<h1>nope</h1>');
    });

    it('sends a redirect with no body and releases the generator', async () => {
        const Guard = component(() => {
            useResponse().redirect('/login', 302);
            return () => <p>never</p>;
        }, { name: 'Guard' });
        const { ssr, state } = trackingSSR();
        const handler = createFetchHandler({ template: TEMPLATE, app: () => (Guard as any)({}), ssr });
        const res = await handler(new Request('http://test.local/private'));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/login');
        expect(res.body).toBeNull();
        expect(await res.text()).toBe('');
        expect(state.returned).toBe(true);
    });

    it('releases the generator when the client disconnects (body cancel)', async () => {
        const { ssr, state } = trackingSSR();
        const handler = createFetchHandler({ template: TEMPLATE, app: () => (Page as any)({}), ssr });
        const res = await handler(new Request('http://test.local/'));
        const reader = res.body!.getReader();
        await reader.read(); // first chunk (the shell)
        await reader.cancel();
        expect(state.returned).toBe(true);
    });

    it('returns a minimal 500 on shell failure', async () => {
        const handler = createFetchHandler({
            template: '<html><body>no outlet</body></html>',
            app: () => (Page as any)({})
        });
        const res = await handler(new Request('http://test.local/'));
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('Internal Server Error');
    });

    it('resolves per-request template and document options with path+search url', async () => {
        const seen: string[] = [];
        const handler = createFetchHandler({
            template: (url) => {
                seen.push(url);
                return TEMPLATE.replace('<head>', `<head><meta name="u" content="${url}">`);
            },
            app: (url) => {
                seen.push(url);
                return (Page as any)({});
            },
            document: (url) => {
                seen.push(url);
                return { assets: { modulepreload: [`/route.js`] } };
            },
            isBot: () => true
        });
        const res = await handler(new Request('http://test.local/about?x=1'));
        const body = await res.text();
        expect(seen).toEqual(['/about?x=1', '/about?x=1', '/about?x=1']);
        expect(body).toContain('<meta name="u" content="/about?x=1">');
        expect(body).toContain('<link rel="modulepreload" href="/route.js">');
    });

    it('threads the platform argument verbatim into every callback', async () => {
        const platform = { env: { KV: 'binding' }, ctx: {} };
        const seen: unknown[] = [];
        const handler = createFetchHandler<typeof platform>({
            template: (_url, _rq, p) => {
                seen.push(p);
                return TEMPLATE;
            },
            app: (_url, _rq, p) => {
                seen.push(p);
                return (Page as any)({});
            },
            document: (_url, _rq, p) => {
                seen.push(p);
                return {};
            },
            isBot: () => true
        });
        await (await handler(new Request('http://test.local/'), platform)).text();
        expect(seen).toHaveLength(3);
        for (const p of seen) expect(p).toBe(platform);
    });
});
