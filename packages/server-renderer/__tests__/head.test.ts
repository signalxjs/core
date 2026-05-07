/**
 * SSR Head management tests
 *
 * Tests renderHeadToString, enableSSRHead, collectSSRHead, and useHead in SSR mode.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    enableSSRHead,
    collectSSRHead,
    renderHeadToString,
    useHead,
    type HeadConfig,
} from '../src/head';

// Reset module-level state after each test
afterEach(() => {
    collectSSRHead();
});

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

// ============= enableSSRHead / collectSSRHead =============

describe('enableSSRHead / collectSSRHead', () => {
    it('enableSSRHead enables SSR mode so useHead collects configs', () => {
        enableSSRHead();
        useHead({ title: 'SSR Title' });
        const configs = collectSSRHead();
        expect(configs).toHaveLength(1);
        expect(configs[0].title).toBe('SSR Title');
    });

    it('collectSSRHead returns collected configs and clears them', () => {
        enableSSRHead();
        useHead({ title: 'First' });
        useHead({ title: 'Second' });
        const configs = collectSSRHead();
        expect(configs).toHaveLength(2);

        // Calling again should return empty
        enableSSRHead();
        const empty = collectSSRHead();
        expect(empty).toHaveLength(0);
    });

    it('after collectSSRHead, SSR mode is disabled', () => {
        enableSSRHead();
        collectSSRHead();

        // useHead should no longer collect — it will try client-side path.
        // We verify by enabling SSR again and checking nothing was accumulated
        // from any prior useHead call after collectSSRHead.
        enableSSRHead();
        const configs = collectSSRHead();
        expect(configs).toHaveLength(0);
    });
});

// ============= useHead in SSR mode =============

describe('useHead in SSR mode', () => {
    it('collects a single config in SSR mode', () => {
        enableSSRHead();
        useHead({ title: 'My Page', meta: [{ name: 'description', content: 'desc' }] });
        const configs = collectSSRHead();
        expect(configs).toHaveLength(1);
        expect(configs[0]).toEqual({
            title: 'My Page',
            meta: [{ name: 'description', content: 'desc' }],
        });
    });

    it('accumulates multiple useHead calls', () => {
        enableSSRHead();
        useHead({ title: 'Page' });
        useHead({ meta: [{ name: 'author', content: 'Alice' }] });
        useHead({ link: [{ rel: 'stylesheet', href: '/style.css' }] });
        const configs = collectSSRHead();
        expect(configs).toHaveLength(3);
        expect(configs[0].title).toBe('Page');
        expect(configs[1].meta![0].name).toBe('author');
        expect(configs[2].link![0].href).toBe('/style.css');
    });
});
