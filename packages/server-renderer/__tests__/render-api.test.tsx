import { describe, it, expect } from 'vitest';
import { renderToNodeStream, renderToString } from '../src/server/render-api';
import { TestCounter, TestText } from './test-utils';

async function collectNodeStream(stream: import('node:stream').Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) {
        out += typeof chunk === 'string' ? chunk : chunk.toString();
    }
    return out;
}

describe('renderToNodeStream (server/render-api)', () => {
    it('returns a Node Readable that yields rendered HTML', async () => {
        const stream = renderToNodeStream((TestCounter as any)({}));
        const html = await collectNodeStream(stream);
        expect(html).toContain('class="counter"');
        expect(html).toContain('class="count"');
    });

    it('forwards context options (and emits the sigx:ready bootstrap)', async () => {
        const stream = renderToNodeStream((TestText as any)({ text: 'hello-node-stream' }));
        const html = await collectNodeStream(stream);
        expect(html).toContain('hello-node-stream');
        expect(html).toContain('window.__SIGX_STREAMING_COMPLETE__');
        expect(html).toContain("sigx:ready");
    });
});

describe('renderToString (server/render-api)', () => {
    it('renders without an explicit context', async () => {
        const html = await renderToString((TestText as any)({ text: 'no-context' }));
        expect(html).toContain('no-context');
    });
});
