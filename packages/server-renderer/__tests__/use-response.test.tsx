/**
 * useResponse — the per-request response seam (rfc-ssr-platform §2.1):
 * status/headers collected on the SSRContext, surfaced on the document
 * shell promise; a redirect short-circuits the body; inert outside SSR.
 */

import { describe, it, expect } from 'vitest';
import { component } from 'sigx';
import { createSSR, useResponse } from '../src/index';

const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

async function collectChunks(gen: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of gen) out += chunk;
    return out;
}

describe('useResponse — shell surface', () => {
    it('status and headers reach the shell promise (headers lowercased, last write wins)', async () => {
        const Page = component(() => {
            useResponse()
                .status(404)
                .header('Cache-Control', 'no-store')
                .header('cache-control', 'max-age=0')
                .header('X-Robots-Tag', 'noindex');
            return () => <h1>not found</h1>;
        }, { name: 'Page' });

        const { chunks, shell } = createSSR().renderDocumentChunks((Page as any)({}), { template: TEMPLATE });
        const head = await shell;
        expect(head.status).toBe(404);
        expect(head.headers).toEqual({ 'cache-control': 'max-age=0', 'x-robots-tag': 'noindex' });
        expect(head.redirect).toBeUndefined();

        // The body still renders for a plain status (a 404 page has content)
        const html = await collectChunks(chunks);
        expect(html).toContain('<h1>not found</h1>');
    });

    it('defaults to status 200 with no calls', async () => {
        const Page = component(() => () => <p>ok</p>, { name: 'Page' });
        const { shell } = createSSR().renderDocumentChunks((Page as any)({}), { template: TEMPLATE });
        expect(await shell).toEqual({ status: 200, headers: {} });
    });

    it('a redirect short-circuits the body and carries its status', async () => {
        const Guard = component(() => {
            useResponse().redirect('/login');
            return () => <p>never sent</p>;
        }, { name: 'Guard' });

        const { chunks, shell } = createSSR().renderDocumentChunks((Guard as any)({}), { template: TEMPLATE });
        const head = await shell;
        expect(head.redirect).toEqual({ location: '/login', status: 302 });
        expect(head.status).toBe(302); // redirect status wins when none set explicitly

        const html = await collectChunks(chunks);
        expect(html).toBe(''); // no bytes — the HTTP layer sends the redirect
    });

    it('an explicit redirect status and an explicit status() both surface', async () => {
        const Gone = component(() => {
            useResponse().status(301).redirect('/moved', 301);
            return () => <p>moved</p>;
        }, { name: 'Gone' });

        const { shell } = createSSR().renderDocumentChunks((Gone as any)({}), { template: TEMPLATE });
        const head = await shell;
        expect(head).toMatchObject({ status: 301, redirect: { location: '/moved', status: 301 } });
    });

    it('nested components share the request recorder', async () => {
        const Inner = component(() => {
            useResponse().header('x-inner', 'yes');
            return () => <i>inner</i>;
        }, { name: 'Inner' });
        const Outer = component(() => {
            useResponse().status(418);
            return () => <div>{(Inner as any)({})}</div>;
        }, { name: 'Outer' });

        const { shell } = createSSR().renderDocumentChunks((Outer as any)({}), { template: TEMPLATE });
        expect(await shell).toMatchObject({ status: 418, headers: { 'x-inner': 'yes' } });
    });
});

describe('useResponse — header-name safety', () => {
    it('special keys become plain data, never prototype mutation', async () => {
        const Page = component(() => {
            useResponse().header('__proto__', 'evil').header('constructor', 'evil2');
            return () => <p>x</p>;
        }, { name: 'Page' });

        const { shell } = createSSR().renderDocumentChunks((Page as any)({}), { template: TEMPLATE });
        const head = await shell;
        expect(Object.prototype).not.toHaveProperty('evil');
        expect(head.headers['__proto__']).toBe('evil');
        expect(head.headers['constructor']).toBe('evil2');
        expect(({} as any).evil).toBeUndefined();
    });
});

describe('useResponse — inert outside SSR', () => {
    it('is chainable and harmless with no server render', () => {
        expect(() => {
            useResponse().status(500).redirect('/x').header('a', 'b').status(200);
        }).not.toThrow();
    });
});
