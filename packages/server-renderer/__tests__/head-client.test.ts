/**
 * Client-side head management tests for useHead / applyHeadClient.
 *
 * The SSR side of head.ts is covered in head.test.ts. This file exercises
 * the DOM-mutating branches that only run when _isSSR is false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useHead, collectSSRHead } from '../src/head';

beforeEach(() => {
    // Ensure SSR mode is off (collectSSRHead clears the flag)
    collectSSRHead();
    document.head.innerHTML = '';
    document.body.removeAttribute('class');
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
    document.title = '';
});

afterEach(() => {
    document.head.innerHTML = '';
    document.body.removeAttribute('class');
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
});

describe('useHead (client mode) — title', () => {
    it('sets document.title from a plain title', () => {
        useHead({ title: 'My Page' });
        expect(document.title).toBe('My Page');
    });

    it('substitutes %s with the title when titleTemplate is provided', () => {
        useHead({ title: 'Home', titleTemplate: '%s · MySite' });
        expect(document.title).toBe('Home · MySite');
    });
});

describe('useHead (client mode) — meta', () => {
    it('appends a <meta name> tag and tags it with data-sigx-head', () => {
        useHead({ meta: [{ name: 'description', content: 'Hello' }] });
        const el = document.head.querySelector('meta[name="description"]');
        expect(el).not.toBeNull();
        expect(el?.getAttribute('content')).toBe('Hello');
        expect(el?.hasAttribute('data-sigx-head')).toBe(true);
    });

    it('replaces an existing matching meta tag (dedup by name)', () => {
        const seed = document.createElement('meta');
        seed.setAttribute('name', 'description');
        seed.setAttribute('content', 'old');
        document.head.appendChild(seed);

        useHead({ meta: [{ name: 'description', content: 'new' }] });
        const matches = document.head.querySelectorAll('meta[name="description"]');
        expect(matches.length).toBe(1);
        expect(matches[0].getAttribute('content')).toBe('new');
    });

    it('dedups by property (og:title)', () => {
        const seed = document.createElement('meta');
        seed.setAttribute('property', 'og:title');
        seed.setAttribute('content', 'old');
        document.head.appendChild(seed);

        useHead({ meta: [{ property: 'og:title', content: 'new' }] });
        const matches = document.head.querySelectorAll('meta[property="og:title"]');
        expect(matches.length).toBe(1);
        expect(matches[0].getAttribute('content')).toBe('new');
    });

    it('dedups by http-equiv', () => {
        const seed = document.createElement('meta');
        seed.setAttribute('http-equiv', 'refresh');
        seed.setAttribute('content', '5');
        document.head.appendChild(seed);

        useHead({ meta: [{ 'http-equiv': 'refresh', content: '10' }] });
        const matches = document.head.querySelectorAll('meta[http-equiv="refresh"]');
        expect(matches.length).toBe(1);
        expect(matches[0].getAttribute('content')).toBe('10');
    });

    it('does not dedup meta tags without name/property/http-equiv', () => {
        useHead({ meta: [{ charset: 'utf-8' }] });
        useHead({ meta: [{ charset: 'iso-8859-1' }] });
        const all = document.head.querySelectorAll('meta');
        // Both should be present since charset has no selector path in applyHeadClient
        expect(all.length).toBeGreaterThanOrEqual(2);
    });
});

describe('useHead (client mode) — link & script', () => {
    it('appends <link> tags with all attributes', () => {
        useHead({ link: [{ rel: 'canonical', href: 'https://example.com/' }] });
        const link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe('https://example.com/');
    });

    it('appends <script src> tags and treats true-valued attrs as boolean attrs', () => {
        // happy-dom logs (but does not throw on) module script loads. Use a
        // non-module type so we don't trip its loader.
        useHead({
            script: [{ src: '/a.js', async: true, defer: false, type: 'text/javascript' }]
        });
        const script = document.head.querySelector('script[src="/a.js"]') as HTMLScriptElement | null;
        expect(script).not.toBeNull();
        expect(script?.hasAttribute('async')).toBe(true);
        expect(script?.hasAttribute('defer')).toBe(false);
        expect(script?.getAttribute('type')).toBe('text/javascript');
    });

    it('appends inline <script>innerHTML</script>', () => {
        useHead({ script: [{ innerHTML: 'console.log(1)' }] });
        const scripts = document.head.querySelectorAll('script');
        const inline = Array.from(scripts).find(s => s.textContent === 'console.log(1)');
        expect(inline).toBeDefined();
    });
});

describe('useHead (client mode) — htmlAttrs / bodyAttrs', () => {
    it('applies htmlAttrs to <html>', () => {
        useHead({ htmlAttrs: { lang: 'en', dir: 'ltr' } });
        expect(document.documentElement.getAttribute('lang')).toBe('en');
        expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    });

    it('applies bodyAttrs to <body>', () => {
        useHead({ bodyAttrs: { class: 'dark-mode' } });
        expect(document.body.getAttribute('class')).toBe('dark-mode');
    });
});

describe('useHead (client mode) — no current instance', () => {
    it('still applies the head changes when called outside a component', () => {
        // We're not inside getCurrentInstance(), so no onUnmounted is registered.
        // Verify the function doesn't throw and the DOM is mutated.
        expect(() => useHead({ title: 'Standalone' })).not.toThrow();
        expect(document.title).toBe('Standalone');
    });
});
