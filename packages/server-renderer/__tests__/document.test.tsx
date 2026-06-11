/**
 * Tests for the renderDocument document-level API: template assembly, head
 * auto-injection (incl. streaming, where head was previously lost),
 * per-request head isolation, blocking (bot) mode output audit, the shell
 * status-code promise, AbortSignal, and default state serialization.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, useAsync } from 'sigx';
import { useHead } from 'sigx';
import {
    createSSR,
    renderDocument,
    renderDocumentToNodeStream,
    renderDocumentToWebStream
} from '../src/index';
import type { Readable } from 'node:stream';

const TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
</head>
<body>
<div id="app"><!--ssr-outlet--></div>
<script type="module" src="/entry-client.js"></script>
</body>
</html>`;

function makePage(title: string, loadedText = 'loaded-data') {
    return component(() => {
        useHead({ title, meta: [{ name: 'description', content: `${title} page` }] });
        const data = useAsync('data-' + title, async () => {
            await new Promise(r => setTimeout(r, 5));
            return loadedText;
        });
        return () => <main class="page">{data.value ?? 'Loading…'}</main>;
    }, { name: 'Page' });
}

async function collectNodeStream(stream: Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) out += chunk;
    return out;
}

async function collectWebStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
    }
    return out;
}

describe('renderDocument — blocking mode (default)', () => {
    it('assembles a complete document with head injected and content inlined', async () => {
        const Page = makePage('Hello');
        const html = await renderDocument((Page as any)({}), { template: TEMPLATE });

        // Document frame preserved
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('<script type="module" src="/entry-client.js">');
        // Head injected before </head>
        expect(html.indexOf('<title>Hello</title>')).toBeLessThan(html.indexOf('</head>'));
        expect(html).toContain('<meta name="description" content="Hello page">');
        // Async content awaited inline
        expect(html).toContain('<main class="page">loaded-data</main>');
        // Outlet replaced
        expect(html).not.toContain('<!--ssr-outlet-->');
    });

    it('emits zero streaming artifacts (crawler/bot audit)', async () => {
        const Page = makePage('Bot');
        const html = await renderDocument((Page as any)({}), { template: TEMPLATE });

        expect(html).not.toContain('data-async-placeholder');
        expect(html).not.toContain('$SIGX_REPLACE');
        expect(html).not.toContain('__SIGX_STREAMING_COMPLETE__');
    });

    it('serializes state by default and can opt out', async () => {
        const Page = makePage('State');
        const withState = await renderDocument((Page as any)({}), { template: TEMPLATE });
        expect(withState).toContain('window.__SIGX_ASYNC__');
        // The blob is keyed by the useAsync key, not by component id
        expect(withState).toContain('"data-State":"loaded-data"');

        const without = await renderDocument((Page as any)({}), {
            template: TEMPLATE,
            serializeState: false
        });
        expect(without).not.toContain('__SIGX_ASYNC__');
    });

    it('throws when the outlet marker is missing', async () => {
        const Page = makePage('X');
        await expect(
            renderDocument((Page as any)({}), { template: '<html><body></body></html>' })
        ).rejects.toThrow(/outlet marker/);
    });
});

describe('renderDocumentToNodeStream — streaming mode (default)', () => {
    it('flushes head with the shell, then streams replacements, then the tail', async () => {
        const Page = makePage('Streamed');
        const { stream, shell } = renderDocumentToNodeStream((Page as any)({}), { template: TEMPLATE });
        await expect(shell).resolves.toBeUndefined();
        const html = await collectNodeStream(stream);

        // Head present in document head (streaming previously LOST it)
        expect(html.indexOf('<title>Streamed</title>')).toBeLessThan(html.indexOf('</head>'));
        // Placeholder + replacement machinery in play
        expect(html).toContain('data-async-placeholder');
        expect(html).toContain('$SIGX_REPLACE(1,');
        expect(html).toContain('loaded-data');
        // State installs before the replace fires
        expect(html.indexOf('window.__SIGX_ASYNC__')).toBeLessThan(html.indexOf('$SIGX_REPLACE(1,'));
        // Completion + tail, in order
        const completionIdx = html.indexOf('__SIGX_STREAMING_COMPLETE__');
        expect(completionIdx).toBeGreaterThan(-1);
        expect(html.indexOf('</html>')).toBeGreaterThan(completionIdx);
    });

    it('shell promise rejects (and onError fires) before any byte on shell failure', async () => {
        const onError = vi.fn();
        const Page = makePage('X');
        const { shell } = renderDocumentToNodeStream((Page as any)({}), {
            template: '<div>no outlet here</div>',
            onError
        });

        await expect(shell).rejects.toThrow(/outlet marker/);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][1]).toBe('shell');
    });

    it('stops early on AbortSignal without the document tail', async () => {
        const Page = makePage('Aborted');
        const controller = new AbortController();
        const { stream, shell } = renderDocumentToNodeStream((Page as any)({}), {
            template: TEMPLATE,
            signal: controller.signal
        });
        await shell;
        controller.abort();
        const html = await collectNodeStream(stream);

        // Shell flushed, but replacements/tail were cut off
        expect(html).toContain('data-async-placeholder');
        expect(html).not.toContain('</html>');
    });
});

describe('renderDocumentToWebStream', () => {
    it('produces the same document as UTF-8 bytes', async () => {
        const Page = makePage('Web');
        const html = await collectWebStream(
            renderDocumentToWebStream((Page as any)({}), { template: TEMPLATE })
        );
        expect(html).toContain('<title>Web</title>');
        expect(html).toContain('loaded-data');
        expect(html.trimEnd().endsWith('</html>')).toBe(true);
    });
});

describe('head isolation across concurrent renders', () => {
    it('does not leak useHead configs between two interleaving renders', async () => {
        const A = makePage('Page-A');
        const B = makePage('Page-B');

        const [htmlA, htmlB] = await Promise.all([
            renderDocument((A as any)({}), { template: TEMPLATE }),
            renderDocument((B as any)({}), { template: TEMPLATE })
        ]);

        expect(htmlA).toContain('<title>Page-A</title>');
        expect(htmlA).not.toContain('Page-B');
        expect(htmlB).toContain('<title>Page-B</title>');
        expect(htmlB).not.toContain('Page-A');
    });
});

describe('createSSR().renderDocument with instance plugins', () => {
    it('keeps instance plugins and does not double-register the state plugin', async () => {
        const seen: string[] = [];
        const probe = {
            name: 'probe',
            server: { setup: () => { seen.push('setup'); } }
        };
        const Page = makePage('Inst');
        const html = await createSSR().use(probe).renderDocument((Page as any)({}), { template: TEMPLATE });

        expect(seen).toEqual(['setup']);
        expect(html).toContain('window.__SIGX_ASYNC__');
        // Exactly one state blob script
        expect(html.split('window.__SIGX_ASYNC__=Object.assign').length - 1).toBe(1);
    });
});
