/**
 * SSR Head management tests
 *
 * Tests renderHeadToString and the per-request useHead collection (configs
 * land on SSRContext._headConfigs via the component instance's ssr._ctx).
 */

import { describe, it, expect } from 'vitest';
import { component, useHead } from 'sigx';
import { renderHeadToString } from '../src/head';
import { createSSR } from '../src/index';
import { createSSRContext } from '../src/server/context';

// ============= renderHeadToString =============

describe('renderHeadToString', () => {
    it('renders title tag', () => {
        const result = renderHeadToString([{ title: 'Hello World' }]);
        expect(result).toBe('<title>Hello World</title>');
    });

    it('applies titleTemplate with %s placeholder', () => {
        const result = renderHeadToString([
            { title: 'Home', titleTemplate: '%s | My Site' },
        ]);
        expect(result).toBe('<title>Home | My Site</title>');
    });

    it('later title overrides earlier title', () => {
        const result = renderHeadToString([
            { title: 'First' },
            { title: 'Second' },
        ]);
        expect(result).toBe('<title>Second</title>');
    });

    it('later titleTemplate overrides earlier titleTemplate', () => {
        const result = renderHeadToString([
            { title: 'Page', titleTemplate: '%s | Old' },
            { titleTemplate: '%s | New' },
        ]);
        expect(result).toBe('<title>Page | New</title>');
    });

    it('renders meta tags with name', () => {
        const result = renderHeadToString([
            { meta: [{ name: 'description', content: 'A great page' }] },
        ]);
        expect(result).toBe('<meta name="description" content="A great page">');
    });

    it('renders meta tags with property (Open Graph)', () => {
        const result = renderHeadToString([
            { meta: [{ property: 'og:title', content: 'OG Title' }] },
        ]);
        expect(result).toBe('<meta property="og:title" content="OG Title">');
    });

    it('deduplicates meta by name (last wins)', () => {
        const result = renderHeadToString([
            { meta: [{ name: 'description', content: 'Old description' }] },
            { meta: [{ name: 'description', content: 'New description' }] },
        ]);
        expect(result).toBe('<meta name="description" content="New description">');
        expect(result).not.toContain('Old description');
    });

    it('deduplicates meta by property (last wins)', () => {
        const result = renderHeadToString([
            { meta: [{ property: 'og:title', content: 'Old OG' }] },
            { meta: [{ property: 'og:title', content: 'New OG' }] },
        ]);
        expect(result).toBe('<meta property="og:title" content="New OG">');
        expect(result).not.toContain('Old OG');
    });

    it('renders link tags', () => {
        const result = renderHeadToString([
            { link: [{ rel: 'canonical', href: 'https://example.com' }] },
        ]);
        expect(result).toBe('<link rel="canonical" href="https://example.com">');
    });

    it('renders script tags with src', () => {
        const result = renderHeadToString([
            { script: [{ src: '/app.js', async: true }] },
        ]);
        expect(result).toBe('<script src="/app.js" async></script>');
    });

    it('renders script tags with innerHTML', () => {
        const result = renderHeadToString([
            { script: [{ type: 'application/ld+json', innerHTML: '{"@type":"WebSite"}' }] },
        ]);
        expect(result).toBe('<script type="application/ld+json">{"@type":"WebSite"}</script>');
    });

    it('returns empty string for empty configs array', () => {
        const result = renderHeadToString([]);
        expect(result).toBe('');
    });

    it('returns empty string when config has no title/meta/link/script', () => {
        const result = renderHeadToString([{ htmlAttrs: { lang: 'en' } }]);
        expect(result).toBe('');
    });

    it('escapes HTML in title', () => {
        const result = renderHeadToString([{ title: '<script>alert("xss")</script>' }]);
        expect(result).toBe('<title>&lt;script&gt;alert("xss")&lt;/script&gt;</title>');
        expect(result).not.toContain('<script>alert');
    });
});

// ============= per-request useHead collection =============

describe('useHead during server rendering', () => {
    function makePage(configs: Parameters<typeof useHead>[0][]) {
        return component(() => {
            for (const config of configs) useHead(config);
            return () => ({ type: 'div', props: {}, key: null, children: ['x'], dom: null } as any);
        }, { name: 'HeadPage' });
    }

    it('collects configs on the per-request SSRContext', async () => {
        const Page = makePage([{ title: 'SSR Title', meta: [{ name: 'description', content: 'desc' }] }]);
        const ssr = createSSR();
        const ctx = createSSRContext();
        await ssr.render((Page as any)({}), ctx);

        expect(ctx._headConfigs).toHaveLength(1);
        expect(ctx._headConfigs[0].title).toBe('SSR Title');
        expect(ctx._headConfigs[0].meta![0].content).toBe('desc');
    });

    it('accumulates multiple useHead calls in render order', async () => {
        const Page = makePage([
            { title: 'Page' },
            { meta: [{ name: 'author', content: 'Alice' }] },
            { link: [{ rel: 'stylesheet', href: '/style.css' }] }
        ]);
        const ssr = createSSR();
        const ctx = createSSRContext();
        await ssr.render((Page as any)({}), ctx);

        expect(ctx._headConfigs).toHaveLength(3);
        expect(ctx._headConfigs[0].title).toBe('Page');
        expect(ctx._headConfigs[1].meta![0].name).toBe('author');
        expect(ctx._headConfigs[2].link![0].href).toBe('/style.css');
    });

    it('does not leak configs between two render contexts', async () => {
        const A = makePage([{ title: 'A' }]);
        const B = makePage([{ title: 'B' }]);
        const ssr = createSSR();
        const ctxA = createSSRContext();
        const ctxB = createSSRContext();
        await Promise.all([
            ssr.render((A as any)({}), ctxA),
            ssr.render((B as any)({}), ctxB)
        ]);

        expect(ctxA._headConfigs).toHaveLength(1);
        expect(ctxA._headConfigs[0].title).toBe('A');
        expect(ctxB._headConfigs).toHaveLength(1);
        expect(ctxB._headConfigs[0].title).toBe('B');
    });
});
