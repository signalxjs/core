/**
 * Head, graduated (rfc-ssr-platform §2.4): htmlAttrs/bodyAttrs patched into
 * the document frame, base/noscript/style rendering, ordering control via
 * priority, full attribute escaping (< and > included), and the explicit
 * innerHTML opt-in with closing-tag neutralization.
 */

import { describe, it, expect } from 'vitest';
import { component, useHead } from 'sigx';
import { createSSR } from '../src/index';
import { renderHeadToString, mergeAttrsIntoTag } from '../src/head';

const TEMPLATE = `<!doctype html><html><head></head><body class="site"><div id="app"><!--ssr-outlet--></div></body></html>`;

describe('renderHeadToString — new tags + escaping', () => {
    it('renders base first, then title, then the rest', () => {
        const html = renderHeadToString([
            { title: 'Page', base: { href: '/app/', target: '_self' }, link: [{ rel: 'canonical', href: '/x' }] }
        ]);
        const baseIdx = html.indexOf('<base');
        const titleIdx = html.indexOf('<title>');
        const linkIdx = html.indexOf('<link');
        expect(baseIdx).toBeGreaterThanOrEqual(0);
        expect(baseIdx).toBeLessThan(titleIdx);
        expect(titleIdx).toBeLessThan(linkIdx);
        expect(html).toContain('<base href="/app/" target="_self">');
    });

    it('renders noscript and style through the innerHTML opt-in, neutralizing closing tags', () => {
        const html = renderHeadToString([{
            style: [{ innerHTML: 'body{color:red}</style><script>alert(1)</script>' }],
            noscript: [{ innerHTML: '<img src="/px.gif"></noscript><script>alert(2)</script>' }],
            script: [{ type: 'text/javascript', innerHTML: 'var s = "</script><script>alert(3)</script>";' }]
        }]);
        // No payload may close its own element
        expect(html).not.toContain('</style><script>');
        expect(html).not.toContain('</noscript><script>');
        expect(html).not.toContain('</script><script>');
        expect(html).toContain('<\\/style>');
        expect(html).toContain('<\\/noscript>');
        expect(html).toContain('<\\/script>');
        // The legit closes are still there
        expect(html).toContain('body{color:red}');
        expect(html).toContain('</style>');
        expect(html).toContain('</noscript>');
    });

    it('escapes < and > in attribute values (full escaping)', () => {
        const html = renderHeadToString([{
            meta: [{ name: 'description', content: '</head><script>alert(1)</script>' }]
        }]);
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;/head&gt;&lt;script&gt;');
    });

    it('orders configs by ascending priority, ties in call order', () => {
        const html = renderHeadToString([
            { link: [{ rel: 'stylesheet', href: '/late.css' }], priority: 10 },
            { link: [{ rel: 'preconnect', href: '/first' }], priority: -10 },
            { link: [{ rel: 'stylesheet', href: '/mid.css' }] }
        ]);
        const first = html.indexOf('/first');
        const mid = html.indexOf('/mid.css');
        const late = html.indexOf('/late.css');
        expect(first).toBeLessThan(mid);
        expect(mid).toBeLessThan(late);
        // priority is control data, never an attribute
        expect(html).not.toContain('priority=');
    });
});

describe('mergeAttrsIntoTag', () => {
    it('appends new attributes and replaces existing ones', () => {
        const out = mergeAttrsIntoTag('<html lang="en"><head></head>', 'html', { lang: 'sv', dir: 'ltr' });
        expect(out).toContain('<html lang="sv" dir="ltr">');
    });

    it('escapes injected values', () => {
        const out = mergeAttrsIntoTag('<body>', 'body', { class: '"><script>alert(1)</script>' });
        expect(out).not.toContain('<script>');
        expect(out).toContain('&quot;&gt;&lt;script&gt;');
    });
});

describe('document frame integration', () => {
    it('htmlAttrs and bodyAttrs patch the template tags (existing attrs preserved/overridden)', async () => {
        const Page = component(() => {
            useHead({
                title: 'Attrs',
                htmlAttrs: { lang: 'sv', 'data-theme': 'dark' },
                bodyAttrs: { class: 'app-ready' }
            });
            return () => <p>hello</p>;
        }, { name: 'Page' });

        const html = await createSSR().renderDocument((Page as any)({}), { template: TEMPLATE });
        expect(html).toContain('<html lang="sv" data-theme="dark">');
        // Existing template class replaced by the collected one
        expect(html).toContain('<body class="app-ready">');
        expect(html).toContain('<title>Attrs</title>');
    });

    it('base and noscript land in the head', async () => {
        const Page = component(() => {
            useHead({ base: { href: '/sub/' }, noscript: [{ innerHTML: 'enable JS' }] });
            return () => <p>x</p>;
        }, { name: 'Page' });

        const html = await createSSR().renderDocument((Page as any)({}), { template: TEMPLATE });
        const headEnd = html.indexOf('</head>');
        expect(html.slice(0, headEnd)).toContain('<base href="/sub/">');
        expect(html.slice(0, headEnd)).toContain('<noscript>enable JS</noscript>');
    });
});
