/**
 * chunksToBytes (rfc-deploy §2.3) — the one string→bytes encoder under
 * renderDocumentToWebStream and createFetchHandler: pull-based backpressure,
 * generator released on cancel.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { chunksToBytes } from '../src/server/bytes';

async function* gen(chunks: string[], onReturn?: () => void): AsyncGenerator<string> {
    try {
        for (const c of chunks) yield c;
    } finally {
        onReturn?.();
    }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out += decoder.decode(value, { stream: true });
    }
}

describe('chunksToBytes', () => {
    it('encodes each chunk as UTF-8 bytes and closes on generator end', async () => {
        const stream = chunksToBytes(gen(['<p>', 'héllo — 世界', '</p>']));
        expect(await readAll(stream)).toBe('<p>héllo — 世界</p>');
    });

    it('releases the generator on cancel (client disconnect)', async () => {
        let released = false;
        const stream = chunksToBytes(gen(['a', 'b', 'c'], () => { released = true; }));
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        expect(released).toBe(true);
    });

    it('errors the stream when the generator throws', async () => {
        async function* failing(): AsyncGenerator<string> {
            yield 'ok';
            throw new Error('mid-stream');
        }
        const reader = chunksToBytes(failing()).getReader();
        await reader.read();
        await expect(reader.read()).rejects.toThrow('mid-stream');
    });
});
