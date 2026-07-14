/**
 * @sigx/server-renderer/node — the Node Readable shapes over the
 * runtime-agnostic chunk primitives (rfc-ssr-platform §2.3): the
 * toNodeStream adapter (async-iterable AND Web-stream sources), and the
 * plugin-instance wiring the entry documents.
 */

import { describe, it, expect } from 'vitest';
import type { Readable } from 'node:stream';
import { component, useData } from 'sigx';
import { createSSR } from '../src/index';
import { toNodeStream, renderToNodeStream } from '../src/node';

async function collect(stream: Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) {
        out += typeof chunk === 'string' ? chunk : chunk.toString();
    }
    return out;
}

const Page = component(() => () => <p class="pg">node</p>, { name: 'Page' });

describe('toNodeStream', () => {
    it('wraps an async-iterable chunk source (renderChunks)', async () => {
        const ssr = createSSR();
        const html = await collect(toNodeStream(ssr.renderChunks((Page as any)({}))));
        expect(html).toContain('<p class="pg">node</p>');
    });

    it('wraps a Web ReadableStream<string> (renderStream)', async () => {
        const ssr = createSSR();
        const html = await collect(toNodeStream(ssr.renderStream((Page as any)({}))));
        expect(html).toContain('<p class="pg">node</p>');
    });

    it('objectMode: false coerces chunks to bytes', async () => {
        async function* chunks() { yield '<a>'; yield '</a>'; }
        const stream = toNodeStream(chunks(), { objectMode: false });
        let bytes = 0;
        let text = '';
        for await (const chunk of stream) {
            bytes += (chunk as Buffer).length;
            text += chunk.toString();
        }
        expect(text).toBe('<a></a>');
        expect(bytes).toBe(7);
    });
});

describe('renderToNodeStream — streamed async content', () => {
    it('carries the $SIGX_REPLACE replacement for a keyed useData read', async () => {
        const Async = component(() => {
            const data = useData('node-entry-async', async () => {
                await new Promise(r => setTimeout(r, 5));
                return { n: 7 };
            });
            return () => <div>{data.value ? (data.value as any).n : 'loading'}</div>;
        }, { name: 'Async' });

        const html = await collect(renderToNodeStream((Async as any)({})));
        expect(html).toContain('data-async-placeholder');
        expect(html).toContain('$SIGX_REPLACE(1,');
        expect(html).toContain('7');
    });
});
