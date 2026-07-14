/**
 * @sigx/server-renderer/node
 *
 * The Node-only streaming surface (rfc-ssr-platform §2.3). Everything that
 * touches `node:stream` lives here — `@sigx/server-renderer` and
 * `@sigx/server-renderer/server` are WinterCG-clean and run on edge runtimes
 * unchanged.
 *
 * These are thin Readable wrappers over the runtime-agnostic chunk
 * primitives (`renderChunks` / `renderDocumentChunks`); for a plugin-driven
 * instance, wrap its chunks yourself:
 *
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * import { toNodeStream } from '@sigx/server-renderer/node';
 *
 * const ssr = createSSR().use(islandsPlugin());
 * toNodeStream(ssr.renderChunks(<App />)).pipe(res);
 * ```
 */

import { Readable } from 'node:stream';
import type { JSXElement, App } from 'sigx';
import { createSSR } from './ssr';
import type { SSRContext, SSRContextOptions } from './server/context';
import type { DocumentOptions } from './server/document';

/** Shared no-plugin instance — created once, reused for all standalone calls. */
const _defaultSSR = createSSR();

/**
 * Wrap an async chunk source (an `AsyncIterable<string>` such as
 * `ssr.renderChunks(...)`, or a Web `ReadableStream<string>`) in a Node.js
 * Readable.
 *
 * `objectMode` defaults to true (each HTML string is one chunk). Pass
 * `{ objectMode: false }` when backpressure should be measured in bytes —
 * the right choice for whole documents piped to slow clients.
 */
export function toNodeStream(
    source: AsyncIterable<string> | ReadableStream<string>,
    options: { objectMode?: boolean } = {}
): Readable {
    const iterable: AsyncIterable<string> =
        Symbol.asyncIterator in source
            ? (source as AsyncIterable<string>)
            : webStreamIterator(source as ReadableStream<string>);
    return Readable.from(iterable, { objectMode: options.objectMode ?? true });
}

async function* webStreamIterator(stream: ReadableStream<string>): AsyncGenerator<string> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Render JSX element or App to a Node.js Readable stream.
 *
 * Faster than `renderToStream()` on Node.js because it bypasses WebStream
 * overhead entirely. Recommended for Express, Fastify, H3, and other
 * Node.js HTTP frameworks.
 *
 * @example
 * ```tsx
 * import { renderToNodeStream } from '@sigx/server-renderer/node';
 *
 * const stream = renderToNodeStream(<App />);
 * stream.pipe(res);
 * ```
 */
export function renderToNodeStream(
    input: JSXElement | App,
    context?: SSRContextOptions | SSRContext
): Readable {
    return toNodeStream(_defaultSSR.renderChunks(input, context));
}

/**
 * Stream a complete HTML document as a Node.js Readable.
 * `shell` settles before any byte is produced — await it, set the status
 * code, then pipe.
 *
 * @example
 * ```tsx
 * import { renderDocumentToNodeStream } from '@sigx/server-renderer/node';
 *
 * const { stream, shell } = renderDocumentToNodeStream(app, { template });
 * try { await shell; } catch { return res.status(500).send(errorPage); }
 * res.status(200).setHeader('content-type', 'text/html');
 * stream.pipe(res);
 * ```
 */
export function renderDocumentToNodeStream(
    input: JSXElement | App,
    options: DocumentOptions
): { stream: Readable; shell: Promise<void> } {
    const { chunks, shell } = _defaultSSR.renderDocumentChunks(input, options);
    return {
        // Non-object mode: backpressure/highWaterMark measured in BYTES —
        // in object mode a few large HTML strings buffer far more memory
        // than intended under slow clients.
        stream: toNodeStream(chunks, { objectMode: false }),
        shell
    };
}
