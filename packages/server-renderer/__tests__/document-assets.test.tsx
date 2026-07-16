/**
 * DocumentOptions.assets (rfc-ssr-platform §3.1): manifest-fed stylesheet +
 * modulepreload links in the first shell flush, automatic modulepreload for
 * boundary chunks recorded during the walk, dedup across both sources, and
 * zero emission when nothing applies.
 */

import { describe, it, expect } from 'vitest';
import { component } from 'sigx';
import { createSSR } from '../src/index';
import type { SSRPlugin } from '../src/plugin';

const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;

const Page = component(() => () => <p>page</p>, { name: 'Page' });

describe('DocumentOptions.assets', () => {
    it('injects stylesheets and modulepreloads before </head>, in the shell', async () => {
        const html = await createSSR().renderDocument((Page as any)({}), {
            template: TEMPLATE,
            assets: {
                stylesheets: ['/assets/app.css'],
                modulepreload: ['/assets/entry.js', '/assets/route-about.js']
            }
        });
        const headEnd = html.indexOf('</head>');
        const head = html.slice(0, headEnd);
        expect(head).toContain('<link rel="stylesheet" href="/assets/app.css">');
        expect(head).toContain('<link rel="modulepreload" href="/assets/entry.js">');
        expect(head).toContain('<link rel="modulepreload" href="/assets/route-about.js">');
    });

    it('modulepreloads boundary chunks recorded during the walk, deduped against assets', async () => {
        const recorder: SSRPlugin = {
            name: 'test:recorder',
            server: {
                resolveBoundary: () => ({
                    hydrate: 'visible',
                    chunk: { url: '/assets/Widget-abc.js', export: 'Widget' }
                })
            }
        };
        const html = await createSSR().use(recorder).renderDocument((Page as any)({}), {
            template: TEMPLATE,
            assets: { modulepreload: ['/assets/Widget-abc.js', '/assets/entry.js'] }
        });
        // Deduped: the boundary chunk equals a provided preload — one link only
        const count = (html.match(/href="\/assets\/Widget-abc\.js"/g) ?? []).length;
        expect(count).toBe(1);
        expect(html).toContain('<link rel="modulepreload" href="/assets/entry.js">');
    });

    it('boundary chunks preload with no assets option at all', async () => {
        const recorder: SSRPlugin = {
            name: 'test:recorder',
            server: {
                resolveBoundary: () => ({ hydrate: 'idle', chunk: { url: '/assets/Late-9.js' } })
            }
        };
        const html = await createSSR().use(recorder).renderDocument((Page as any)({}), { template: TEMPLATE });
        const headEnd = html.indexOf('</head>');
        expect(html.slice(0, headEnd)).toContain('<link rel="modulepreload" href="/assets/Late-9.js">');
    });

    it('plugins contribute modulepreloads via the assets hook, deduped and escaped', async () => {
        const contributes: SSRPlugin = {
            name: 'test:pack-runtime',
            server: {
                resolveBoundary: () => ({ hydrate: 'visible', chunk: { url: '/assets/Widget-abc.js' } }),
                // A pack whose runtime loads lazily keeps its chunk fetch off
                // the critical path here (#293).
                assets: () => ({
                    modulepreload: [
                        '/assets/hydration-core-1.js',
                        '/assets/Widget-abc.js', // duplicate of the boundary chunk
                        '/assets/evil".js'
                    ]
                })
            }
        };
        const html = await createSSR().use(contributes).renderDocument((Page as any)({}), {
            template: TEMPLATE
        });
        const headEnd = html.indexOf('</head>');
        const head = html.slice(0, headEnd);
        expect(head).toContain('<link rel="modulepreload" href="/assets/hydration-core-1.js">');
        expect((html.match(/href="\/assets\/Widget-abc\.js"/g) ?? []).length).toBe(1);
        expect(head).toContain('/assets/evil&quot;.js');
    });

    it('the assets hook sees the boundaries this request recorded', async () => {
        let sawBoundary = false;
        const inspects: SSRPlugin = {
            name: 'test:inspects',
            server: {
                resolveBoundary: () => ({ hydrate: 'idle', chunk: { url: '/assets/A.js' } }),
                assets: (ctx) => {
                    sawBoundary = ctx._boundaries.size > 0;
                    // A pack preloads its runtime only when it recorded
                    // schedulable boundaries — the policy this seam exists for.
                    return sawBoundary ? { modulepreload: ['/assets/rt.js'] } : undefined;
                }
            }
        };
        const html = await createSSR().use(inspects).renderDocument((Page as any)({}), { template: TEMPLATE });
        expect(sawBoundary).toBe(true);
        expect(html).toContain('<link rel="modulepreload" href="/assets/rt.js">');
    });

    it('escapes URLs and emits nothing when there is nothing to emit', async () => {
        const html = await createSSR().renderDocument((Page as any)({}), { template: TEMPLATE });
        expect(html).not.toContain('modulepreload');
        expect(html).not.toContain('rel="stylesheet"');

        const evil = await createSSR().renderDocument((Page as any)({}), {
            template: TEMPLATE,
            assets: { modulepreload: ['/x.js"><script>alert(1)</script>'] }
        });
        expect(evil).not.toContain('<script>alert');
        expect(evil).toContain('&quot;&gt;&lt;script&gt;');
    });
});
