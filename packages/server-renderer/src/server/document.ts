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
 * - `'blocking'` — every keyed `useAsync()`/`useStream()` resolves inline:
 *   complete content, no placeholders, no streaming replacement scripts
 *   (default for `renderDocument`). Useful for crawlers and AI agents: the
 *   app can pick the mode per user-agent. The state blob `<script>` is
 *   still emitted unless `serializeState: false`.
 *
 * BOTH modes emit the completion script (`__SIGX_STREAMING_COMPLETE__` +
 * `sigx:ready`) after the last content chunk — clients gate hydration on
 * it, and a blocking document is complete when delivered. With a standard
 * template it lands just before `</body>`; templates without a closing
 * body tag get it appended after the template tail instead.
 *
 * State serialization is ON by default here (`serializeState: false` to
 * disable) — this is the zero-config entry point; the lower-level render
 * APIs stay opt-in to keep their output stable.
 */

import type { JSXElement, AppContext } from 'sigx';
import type { SSRPlugin } from '../plugin';
import { createSSRContext, type SSRContext, type SSRContextOptions } from './context';
import { renderToChunks } from './render-core';
import { emitBoundaryTable } from './serialize';
import { renderHeadToString, collectRootAttrs, mergeAttrsIntoTag } from '../head';
import { responseSummary, type SSRResponse } from '../response';

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
     * no placeholders, no streaming replacement scripts (default for
     * renderDocument). The state blob is still emitted unless
     * `serializeState: false`, and both modes emit the hydration-gate
     * completion script (`sigx:ready`) at the end of the body.
     */
    mode?: 'stream' | 'blocking';

    /**
     * Abort rendering (e.g. client disconnect, timeout). The stream ends
     * early without the document tail; string renders reject.
     */
    signal?: AbortSignal;

    // onError / renderError are inherited from SSRContextOptions
    // (rfc-ssr-platform §2.2): ONE callback receives per-component render
    // failures (info.componentId set) and request-level failures (shell
    // preparation, stream errors — info carries only the phase). A shell
    // failure fires before any byte is produced, so the caller can still
    // send a 500 page.

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
    /**
     * Template after the outlet UP TO </body> — flushed WITH the shell so
     * the browser starts downloading entry scripts immediately instead of
     * after the last async chunk (module scripts execute after parsing
     * completes either way, so this cannot race hydration).
     */
    postBody: string;
    /** The closing tail (</body></html>…) — emitted after all chunks. */
    postTail: string;
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
    ctx._appContext = input.appContext;
    ctx._plugins = engine.plugins;
    for (const plugin of engine.plugins) {
        plugin.server?.setup?.(ctx);
    }
    ctx._streaming = options.mode !== 'blocking';

    // Render the app shell. In streaming mode async components leave
    // placeholders, so this completes quickly; in blocking mode every
    // useAsync/useStream resolves inline.
    const shellChunks: string[] = [];
    for await (const chunk of renderToChunks(input.element, ctx, null, input.appContext)) {
        shellChunks.push(chunk);
        throwIfAborted(options.signal);
    }
    const shellHtml = shellChunks.join('');
    // Shell produced — later failures (deferred renders) are stream-phase
    // for error routing.
    ctx._phase = 'stream';

    // Head: collected per-request by useHead via the component instances
    const headConfigs = ctx._headConfigs;
    const headHtml = headConfigs.length > 0 ? renderHeadToString(headConfigs) : '';

    // Plugin-injected HTML (the state blob arrives through this hook)
    let injected = '';
    for (const plugin of engine.plugins) {
        const i = plugin.server?.getInjectedHTML?.(ctx);
        if (i) injected += typeof i === 'string' ? i : await i;
    }

    // Boundary table (core protocol — empty renders emit nothing)
    injected += emitBoundaryTable(ctx);

    let pre = options.template.slice(0, outletIdx);
    const post = options.template.slice(outletIdx + outlet.length);

    if (headHtml) {
        const headClose = pre.search(/<\/head\s*>/i);
        pre = headClose >= 0
            ? pre.slice(0, headClose) + headHtml + '\n' + pre.slice(headClose)
            : pre + headHtml;
    }

    // htmlAttrs/bodyAttrs collected via useHead patch the template's own
    // <html>/<body> open tags (rfc-ssr-platform §2.4) — both live in `pre`
    // (the template up to the outlet).
    if (headConfigs.length > 0) {
        const { htmlAttrs, bodyAttrs } = collectRootAttrs(headConfigs);
        pre = mergeAttrsIntoTag(pre, 'html', htmlAttrs);
        pre = mergeAttrsIntoTag(pre, 'body', bodyAttrs);
    }

    // Split the tail at </body>: everything before it (entry scripts!)
    // flushes with the shell; only the closing tags wait for the stream.
    // No </body> in the template → flush the WHOLE tail with the shell
    // (streamed chunks append at document end, which browsers tolerate);
    // delaying it would defeat the early-script-download behavior.
    const bodyClose = post.search(/<\/body\s*>/i);
    const postBody = bodyClose >= 0 ? post.slice(0, bodyClose) : post;
    const postTail = bodyClose >= 0 ? post.slice(bodyClose) : '';

    return { ctx, pre, shell: shellHtml + injected, postBody, postTail };
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

    // A redirect requested via useResponse() short-circuits the body: the
    // shell promise carries the redirect, the HTTP layer sends it, and no
    // document bytes are produced (rfc-ssr-platform §2.1).
    if (p.ctx._response.redirect) return;

    // First flush: template head (with collected head tags) + shell + state
    // + the rest of the body markup incl. entry scripts (downloads start
    // now; module execution waits for parse end regardless)
    yield p.pre + p.shell + p.postBody;

    try {
        for await (const chunk of engine.streamAsyncChunks(p.ctx)) {
            if (options.signal?.aborted) return;
            yield chunk;
        }
        // An abort after the final chunk still means "end early, no tail":
        // don't signal completion for a document we're cutting short.
        if (options.signal?.aborted) return;
        // Emitted in BOTH modes: clients gate hydration on this flag/event
        // (`__SIGX_STREAMING_COMPLETE__` / `sigx:ready`), and a blocking
        // document is by definition complete when delivered. The inline
        // script executes during parse, before deferred module scripts, so
        // the entry's flag check always sees it.
        yield COMPLETION_SCRIPT;
    } catch (e) {
        options.onError?.(e as Error, { phase: 'stream' });
        return; // end without the closing tail — visibly truncated
    }

    if (options.signal?.aborted) return;
    yield p.postTail;
}

/** Kick off shell preparation eagerly, routing failures to onError('shell'). */
function startPrepare(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): Promise<PreparedDocument> {
    const prep = prepareDocument(engine, input, options);
    prep.catch(e => options.onError?.(e as Error, { phase: 'shell' }));
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
    const out: string[] = [];
    for await (const chunk of documentChunks(engine, prep, resolved)) {
        out.push(chunk);
    }
    // A stream may end early on abort (the consumer sees the truncation);
    // a STRING render must reject — silently returning partial HTML would
    // look like a successful render.
    throwIfAborted(resolved.signal);
    return out.join('');
}

/**
 * Document as a raw async chunk generator plus a `shell` promise that
 * settles before any byte is produced — await it to write the response
 * head (status, headers, redirect — collected via useResponse()) before
 * piping. The runtime-agnostic primitive the Node entry wraps in a Readable.
 */
export function renderDocumentChunksImpl(
    engine: DocumentEngine,
    input: DocumentInput,
    options: DocumentOptions
): { chunks: AsyncGenerator<string>; shell: Promise<SSRResponse> } {
    const resolved: DocumentOptions = { ...options, mode: options.mode ?? 'stream' };
    const prep = startPrepare(engine, input, resolved);
    const shell = prep.then(p => responseSummary(p.ctx));
    shell.catch(() => { /* handled via onError / stream error */ });
    return {
        chunks: documentChunks(engine, prep, resolved),
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
