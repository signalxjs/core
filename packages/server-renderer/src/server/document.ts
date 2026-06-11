/**
 * Document-level rendering: the engine owns the complete HTML response.
 *
 * `renderDocument*` take an HTML template with an outlet marker and assemble
 * the full document — collected head tags injected before `</head>`, the app
 * shell at the outlet, the serialized state blob, streamed async replacement
 * chunks, and the template tail. This replaces hand-splicing
 * `template.replace('<!--ssr-outlet-->', html)` in user servers, and fixes
 * head handling for streaming (previously collected but never emitted).
 *
 * Modes:
 * - `'stream'`  — shell-first with async placeholders, out-of-order
 *   replacement chunks over the wire (default for the stream variants).
 * - `'blocking'` — every `useAsync()`/`useStream()` resolves inline: complete, script-free
 *   content (default for `renderDocument`). Useful for crawlers and AI
 *   agents: the app can pick the mode per user-agent.
 *
 * State serialization is ON by default here (`serializeState: false` to
 * disable) — this is the zero-config entry point; the lower-level render
 * APIs stay opt-in to keep their output stable.
 */

import { Readable } from 'node:stream';
import type { JSXElement, AppContext } from 'sigx';
import type { SSRPlugin } from '../plugin';
import { createSSRContext, type SSRContext, type SSRContextOptions } from './context';
import { renderToChunks } from './render-core';
import { collectSSRHead, enableSSRHead, renderHeadToString } from '../head';

/** Same completion signal the plain streaming APIs emit. */
const COMPLETION_SCRIPT = `<script>window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;

export interface DocumentOptions extends SSRContextOptions {
    /** Full HTML template containing the outlet marker. */
    template: string;

    /** Outlet marker the app HTML replaces. Default: `<!--ssr-outlet-->` */
    outlet?: string;

    /**
     * `'stream'`: shell + out-of-order async chunks (default for the stream
     * variants). `'blocking'`: all async data awaited inline — complete HTML,
     * no placeholders, no replacement scripts (default for renderDocument).
     */
    mode?: 'stream' | 'blocking';

    /**
     * Abort rendering (e.g. client disconnect, timeout). The stream ends
     * early without the document tail; string renders reject.
     */
    signal?: AbortSignal;

    /**
     * Error callback. `'shell'` fires before any byte is produced (the
     * caller can still send a 500 page); `'stream'` fires mid-stream after
     * the shell flushed (per-component errors stream their fallbacks and do
     * NOT reach this — only stream-level failures do).
     */
    onError?: (error: Error, phase: 'shell' | 'stream') => void;

    /**
     * Serialize resolved useAsync/useStream values for hydration pickup.
     * Default: true (unlike the lower-level render APIs, which are opt-in).
     */
    serializeState?: boolean;
}

/** Rendering internals handed in by createSSR (avoids a module cycle). */
export interface DocumentEngine {
    plugins: SSRPlugin[];
    streamAsyncChunks(ctx: SSRContext): AsyncGenerator<string>;
}

export interface DocumentInput {
    element: JSXElement;
    appContext: AppContext | null;
}

interface PreparedDocument {
    ctx: SSRContext;
    /** Template up to the outlet, head HTML injected before </head>. */
    pre: string;
    /** App shell HTML + plugin-injected HTML (state blob included). */
    shell: string;
    /** Template after the outlet. */
    post: string;
    streaming: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('renderDocument aborted');
    }
}

/**
 * Render the shell and assemble the document frame. Resolves before any byte
 * is produced — callers use this as the status-code decision point.
 */
async function prepareDocument(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): Promise<PreparedDocument> {
    const outlet = options.outlet ?? '<!--ssr-outlet-->';
    const outletIdx = options.template.indexOf(outlet);
    if (outletIdx < 0) {
        throw new Error(`renderDocument: outlet marker "${outlet}" not found in template`);
    }

    throwIfAborted(options.signal);

    const ctx = createSSRContext(options);
    ctx._plugins = engine.plugins;
    for (const plugin of engine.plugins) {
        plugin.server?.setup?.(ctx);
    }
    const streaming = options.mode !== 'blocking';
    ctx._streaming = streaming;

    enableSSRHead();

    // Render the app shell. In streaming mode async components leave
    // placeholders, so this completes quickly; in blocking mode every
    // useAsync/useStream resolves inline.
    let shellHtml = '';
    for await (const chunk of renderToChunks(input.element, ctx, null, input.appContext)) {
        shellHtml += chunk;
        throwIfAborted(options.signal);
    }

    // Head: per-request context collection plus the legacy module-level path
    const headConfigs = [...ctx._headConfigs, ...collectSSRHead()];
    const headHtml = headConfigs.length > 0 ? renderHeadToString(headConfigs) : '';

    // Plugin-injected HTML (the state blob arrives through this hook)
    let injected = '';
    for (const plugin of engine.plugins) {
        const i = plugin.server?.getInjectedHTML?.(ctx);
        if (i) injected += typeof i === 'string' ? i : await i;
    }

    let pre = options.template.slice(0, outletIdx);
    const post = options.template.slice(outletIdx + outlet.length);

    if (headHtml) {
        const headClose = pre.search(/<\/head\s*>/i);
        pre = headClose >= 0
            ? pre.slice(0, headClose) + headHtml + '\n' + pre.slice(headClose)
            : pre + headHtml;
    }

    return { ctx, pre, shell: shellHtml + injected, post, streaming };
}

/**
 * The document as an async chunk generator: frame flush, async replacement
 * chunks, completion signal, tail. Shared by all three public shapes.
 */
async function* documentChunks(
    engine: DocumentEngine,
    prep: Promise<PreparedDocument>,
    options: DocumentOptions
): AsyncGenerator<string> {
    // Shell failures were already routed to onError('shell') by the caller —
    // rethrow so the stream errors before producing bytes.
    const p = await prep;

    // First flush: template head (with collected head tags) + shell + state
    yield p.pre + p.shell;

    try {
        for await (const chunk of engine.streamAsyncChunks(p.ctx)) {
            if (options.signal?.aborted) return;
            yield chunk;
        }
        if (p.streaming) {
            yield COMPLETION_SCRIPT;
        }
    } catch (e) {
        options.onError?.(e as Error, 'stream');
        return; // end without the tail — the document is visibly truncated
    }

    yield p.post;
}

/** Kick off shell preparation eagerly, routing failures to onError('shell'). */
function startPrepare(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): Promise<PreparedDocument> {
    const prep = prepareDocument(engine, input, options);
    prep.catch(e => options.onError?.(e as Error, 'shell'));
    return prep;
}

/** Complete document as a string. Default mode: 'blocking'. */
export async function renderDocumentImpl(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): Promise<string> {
    const resolved: DocumentOptions = { ...options, mode: options.mode ?? 'blocking' };
    const prep = startPrepare(engine, input, resolved);
    let out = '';
    for await (const chunk of documentChunks(engine, prep, resolved)) {
        out += chunk;
    }
    return out;
}

/**
 * Document as a Node.js Readable plus a `shell` promise that settles before
 * any byte is produced — await it to decide the HTTP status code, then pipe.
 */
export function renderDocumentToNodeStreamImpl(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): { stream: Readable; shell: Promise<void> } {
    const resolved: DocumentOptions = { ...options, mode: options.mode ?? 'stream' };
    const prep = startPrepare(engine, input, resolved);
    const shell = prep.then(() => undefined as void);
    shell.catch(() => { /* handled via onError / stream error */ });
    return {
        stream: Readable.from(documentChunks(engine, prep, resolved), { objectMode: true }),
        shell
    };
}

/** Document as a web ReadableStream of UTF-8 bytes (edge-friendly). */
export function renderDocumentToWebStreamImpl(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): ReadableStream<Uint8Array> {
    const resolved: DocumentOptions = { ...options, mode: options.mode ?? 'stream' };
    const prep = startPrepare(engine, input, resolved);
    const gen = documentChunks(engine, prep, resolved);
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await gen.next();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(value));
                }
            } catch (error) {
                controller.error(error);
            }
        },
        cancel() {
            void gen.return(undefined);
        }
    });
}
