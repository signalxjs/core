/**
 * SSR Factory
 *
 * Creates an SSR instance. Strategy packs install on the APP
 * (`app.use(islandsPlugin())` — their `install(app)` registers the server
 * hooks via `provideSSRPlugin`), and every render method that receives the
 * App merges those app-carried plugins in. Instance-level plugins
 * (`createSSR({ plugins })`) are the advanced/engine-internal channel.
 *
 * @example
 * ```ts
 * import { defineApp } from 'sigx';
 * import { createSSR } from '@sigx/server-renderer';
 *
 * const app = defineApp(<App />).use(islandsPlugin({ manifest }));
 * const html = await createSSR().render(app);
 * ```
 */

import type { SSRPlugin } from './plugin';
import { mergeSSRPlugins, initPluginContext } from './server/plugin-setup';
import type { JSXElement } from 'sigx';
import type { App, AppContext } from 'sigx';
import { SSRContext, createSSRContext, SSRContextOptions, SSRErrorInfo } from './server/context';
import { renderToChunks, renderVNodeToString, defaultRenderError } from './server/render-core';
import { generateStreamingScript, generateReplacementScript, generateAppendBootstrap } from './server/streaming';
import { renderHeadToString } from './head';
import type { StreamCallbacks } from './server/types';
import { stateSerializationPlugin } from './server/state-plugin';
import { emitBoundaryTable, boundaryPatchJs, scriptOpen } from './server/serialize';
import type { SSRResponse } from './response';
import {
    renderDocumentImpl,
    renderDocumentChunksImpl,
    renderDocumentToWebStreamImpl,
    type DocumentOptions,
    type DocumentEngine
} from './server/document';

/**
 * Check if the input is an App instance (created via defineApp)
 */
function isApp(input: any): input is App<any> {
    return input && typeof input === 'object' && '_rootComponent' in input && '_context' in input;
}

/**
 * Extract the JSX element and optional AppContext from a render input.
 */
function extractInput(input: JSXElement | App): { element: JSXElement; appContext: AppContext | null } {
    if (isApp(input)) {
        return { element: input._rootComponent, appContext: input._context };
    }
    return { element: input, appContext: null };
}

/**
 * Yield all async streaming chunks — core-managed and plugin-managed — interleaved
 * so the fastest component streams first regardless of who manages it.
 *
 * Core-managed: ctx._pendingAsync (from render-core when no plugin overrides)
 * Plugin-managed: plugin.server.getStreamingChunks() async generators
 *
 * Both are raced together using a unified promise race loop.
 */
async function* streamAllAsyncChunks(
    ctx: SSRContext,
    plugins: SSRPlugin[]
): AsyncGenerator<string> {
    type TaggedResult = { index: number; script: string };

    // Pump slots live at PUMP_BASE and above. Core slots can GROW while
    // streaming — deferred renders (Defer children, nested useData
    // components) push new entries onto ctx._pendingAsync mid-stream — so
    // they get the open-ended range below PUMP_BASE.
    const PUMP_BASE = 1 << 30;

    // Collect plugin streaming generators
    const pluginGenerators: AsyncGenerator<string>[] = [];
    for (const plugin of plugins) {
        const chunks = plugin.server?.getStreamingChunks?.(ctx);
        if (chunks) pluginGenerators.push(chunks);
    }

    // Nothing to stream
    if (ctx._pendingAsync.length === 0 && pluginGenerators.length === 0 && ctx._pendingStreams.length === 0) return;

    // Emit the $SIGX_REPLACE bootstrap script (needed by core replacements).
    // If core async only appears mid-stream (deferred renders), the loop
    // below emits it just-in-time before the first core replacement.
    let bootstrapEmitted = false;
    if (ctx._pendingAsync.length > 0) {
        yield generateStreamingScript(ctx._nonce);
        bootstrapEmitted = true;
    }

    // $SIGX_APPEND bootstrap for progressive text streams (useStream) —
    // upfront when streams registered during the shell render; just-in-time
    // for streams that appear mid-stream (inside deferred renders).
    let appendBootstrapEmitted = false;
    if (ctx._pendingStreams.length > 0) {
        yield generateAppendBootstrap(ctx._nonce);
        appendBootstrapEmitted = true;
    }

    // Tagged promises for core-managed async components, keyed by their
    // ctx._pendingAsync index; entries are removed once yielded.
    const corePromises = new Map<number, Promise<TaggedResult>>();
    let coreCount = 0;

    function makeCorePromise(index: number): Promise<TaggedResult> {
        const pending = ctx._pendingAsync[index];
        return pending.promise.then(html => {
            // Let plugins augment the resolved HTML
            let finalHtml = html;
            let extraScript = '';
            let preScript = '';
            for (const plugin of plugins) {
                const result = plugin.server?.onAsyncComponentResolved?.(pending.id, finalHtml, ctx);
                if (result) {
                    if (result.html !== undefined) finalHtml = result.html;
                    if (result.script) extraScript += result.script;
                    if (result.preScript) preScript += result.preScript;
                }
            }
            // Boundary-table patch: plugins above may have mutated the
            // resolved record (post-async state re-capture), and the
            // deferred render may have CREATED boundaries that exist in no
            // earlier emission (#279 — a plain async wrapper full of
            // pack-claimed components). Unconditional: boundaryPatchJs
            // drains everything unflushed and returns '' when there is
            // nothing to say. Prepended: records must land before any
            // plugin preScript that reads them.
            preScript = boundaryPatchJs(ctx, pending.id) + preScript;
            return {
                index,
                script: generateReplacementScript(pending.id, finalHtml, extraScript || undefined, preScript || undefined, ctx._nonce)
            };
        }).catch(error => {
            // A streamed component failure routes through the same error
            // seam as the synchronous path (rfc-ssr-platform §2.2): report
            // via onError, render via renderError — no hard-coded markup.
            const err = error instanceof Error ? error : new Error(String(error));
            const info: SSRErrorInfo = {
                phase: 'stream',
                componentId: pending.id,
                ...(ctx._boundaries.has(pending.id) ? { boundaryId: pending.id } : {})
            };
            try {
                ctx._onError?.(err, info);
            } catch (hookErr) {
                if (__DEV__) {
                    console.error('Error in onError callback:', hookErr);
                }
            }
            if (__DEV__) {
                console.error(`Error streaming async component ${pending.id}:`, error);
            }
            const html = ctx._renderError ? ctx._renderError(err, info) : defaultRenderError(err, info);
            return {
                index,
                script: generateReplacementScript(pending.id, html, undefined, undefined, ctx._nonce)
            };
        });
    }

    /**
     * Pick up pending async components added since the last check — deferred
     * renders that are themselves being awaited can push new entries onto
     * ctx._pendingAsync while the race loop runs.
     */
    function syncCorePromises(): void {
        while (coreCount < ctx._pendingAsync.length) {
            const index = coreCount++;
            corePromises.set(index, makeCorePromise(index));
        }
    }

    // Set up pump pattern for plugin generators and useStream() token
    // streams so they can be raced alongside core
    interface PumpState {
        generator: AsyncGenerator<string>;
        done: boolean;
        /** Progressive useStream() pump — its chunks need $SIGX_APPEND */
        isStream: boolean;
    }
    const pumps: PumpState[] = pluginGenerators.map(g => ({ generator: g, done: false, isStream: false }));
    let streamCount = 0;

    // Active pump promises, keyed by their slot index (PUMP_BASE + i)
    const activePumps = new Map<number, Promise<TaggedResult>>();

    // pumpNext pulls ONE value from a generator. It does NOT pre-queue the
    // next pull — the consumer is responsible for calling pumpNext again
    // after it has yielded the current value (see the race loop below).
    //
    // The eager-re-queue variant silently dropped chunks 2..N from plugin
    // streams: a generator that yields multiple already-resolved chunks
    // would drain end-to-end through the microtask queue (each .then()
    // scheduled the next pull, which resolved immediately, scheduling the
    // next .then(), ...) before the consumer's first `await
    // Promise.race(...)` got a turn. When the generator hit `done: true`,
    // the slot was deleted from `activePumps` and the consumer woke up to
    // an empty map after a single yield — ending the stream prematurely
    // even though most of the chunks were never observed. See
    // signalxjs/core#17.
    function pumpNext(pumpIdx: number): Promise<TaggedResult> {
        const slotIndex = PUMP_BASE + pumpIdx;
        return pumps[pumpIdx].generator.next().then(({ value, done }) => {
            if (done) {
                pumps[pumpIdx].done = true;
                activePumps.delete(slotIndex);
                return { index: slotIndex, script: '' };
            }
            return { index: slotIndex, script: value || '' };
        });
    }

    // Start initial pumps
    for (let i = 0; i < pumps.length; i++) {
        activePumps.set(PUMP_BASE + i, pumpNext(i));
    }

    /** Pick up useStream() pumps registered since the last check. */
    function syncStreamPumps(): void {
        while (streamCount < ctx._pendingStreams.length) {
            const generator = ctx._pendingStreams[streamCount++];
            const pumpIdx = pumps.length;
            pumps.push({ generator, done: false, isStream: true });
            activePumps.set(PUMP_BASE + pumpIdx, pumpNext(pumpIdx));
        }
    }

    function getRaceablePromises(): Promise<TaggedResult>[] {
        syncCorePromises();
        syncStreamPumps();
        const promises: Promise<TaggedResult>[] = [...corePromises.values()];
        for (const [, p] of activePumps) {
            promises.push(p);
        }
        return promises;
    }

    while (true) {
        const raceable = getRaceablePromises();
        if (raceable.length === 0) break;

        const winner = await Promise.race(raceable);

        if (winner.script) {
            // Just-in-time bootstraps for work that only appeared mid-stream
            if (!bootstrapEmitted && winner.index < PUMP_BASE) {
                yield generateStreamingScript(ctx._nonce);
                bootstrapEmitted = true;
            }
            if (!appendBootstrapEmitted && winner.index >= PUMP_BASE && pumps[winner.index - PUMP_BASE].isStream) {
                yield generateAppendBootstrap(ctx._nonce);
                appendBootstrapEmitted = true;
            }
            yield winner.script;
        }

        if (winner.index < PUMP_BASE) {
            corePromises.delete(winner.index);
        } else {
            // Pump slot — re-queue the next pull now that the consumer has
            // yielded the current value. If the generator hit `done: true`
            // (in which case `pumps[pumpIdx].done` was set inside pumpNext
            // and the slot was removed from `activePumps`), skip re-queue.
            const pumpIdx = winner.index - PUMP_BASE;
            if (!pumps[pumpIdx].done) {
                activePumps.set(winner.index, pumpNext(pumpIdx));
            }
        }
    }
}

export interface SSRInstance {
    /** Render to a complete HTML string */
    render(input: JSXElement | App, options?: SSRContextOptions | SSRContext): Promise<string>;

    /** Render to a ReadableStream with streaming support */
    renderStream(input: JSXElement | App, options?: SSRContextOptions | SSRContext): ReadableStream<string>;

    /**
     * Render to a raw async chunk generator — the runtime-agnostic primitive
     * both stream shapes wrap. Consume it directly, or hand it to
     * `toNodeStream()` from `@sigx/server-renderer/node` for a Node Readable.
     */
    renderChunks(input: JSXElement | App, options?: SSRContextOptions | SSRContext): AsyncGenerator<string>;

    /** Render with callbacks for fine-grained streaming control */
    renderStreamWithCallbacks(
        input: JSXElement | App,
        callbacks: StreamCallbacks,
        options?: SSRContextOptions | SSRContext
    ): Promise<void>;

    /**
     * Render a COMPLETE HTML document from a template (head auto-injection,
     * state blob, async content). Default mode: 'blocking' — full content
     * inline, no placeholders or replacement scripts (crawler/AI-agent
     * friendly); the `sigx:ready` completion script is still emitted so
     * gated hydration runs.
     */
    renderDocument(input: JSXElement | App, options: DocumentOptions): Promise<string>;

    /**
     * Stream a complete HTML document as a raw async chunk generator plus
     * the `shell` promise that settles before any byte is produced — await
     * it to pick the HTTP status code. The runtime-agnostic primitive the
     * Node and Web document streams wrap (`renderDocumentToNodeStream` in
     * `@sigx/server-renderer/node` is `toNodeStream()` over this).
     * Default mode: 'stream'.
     */
    renderDocumentChunks(
        input: JSXElement | App,
        options: DocumentOptions
    ): { chunks: AsyncGenerator<string>; shell: Promise<SSRResponse> };

    /** Stream a complete HTML document as UTF-8 bytes (edge-friendly). Default mode: 'stream'. */
    renderDocumentToWebStream(input: JSXElement | App, options: DocumentOptions): ReadableStream<Uint8Array>;

    /**
     * Create a raw SSRContext with the INSTANCE plugins pre-configured.
     * App-carried plugins require passing the App to a render method — this
     * shape has no input to extract an app context from.
     */
    createContext(options?: SSRContextOptions): SSRContext;
}

export interface CreateSSROptions {
    /**
     * Instance-level plugins. Advanced/internal: the public install path is
     * `app.use(pack())` on the rendered App — app-carried plugins are merged
     * in per render call (after instance plugins, deduped by name, first
     * wins). Used by the engine itself (default state plugin), tests, and
     * custom-engine injection.
     */
    plugins?: SSRPlugin[];
}

/**
 * Create an SSR instance.
 */
export function createSSR(instanceOptions?: CreateSSROptions): SSRInstance {
    const instancePlugins: SSRPlugin[] = instanceOptions?.plugins ?? [];

    function makeContext(
        options: SSRContextOptions | SSRContext | undefined,
        appContext: AppContext | null
    ): { ctx: SSRContext; plugins: SSRPlugin[] } {
        // Accept an existing SSRContext (has _componentId) or create one from options
        const ctx = (options && '_componentId' in options)
            ? options as SSRContext
            : createSSRContext(options as SSRContextOptions | undefined);
        // App context first — plugin setup hooks may read it.
        ctx._appContext = appContext;
        const plugins = mergeSSRPlugins(instancePlugins, appContext);
        initPluginContext(ctx, plugins);
        return { ctx, plugins };
    }

    // Closure-scoped (not a `this`-sensitive method — survives destructuring):
    // the runtime-agnostic chunk primitive both stream shapes wrap.
    function renderChunks(
        input: JSXElement | App,
        options?: SSRContextOptions | SSRContext
    ): AsyncGenerator<string> {
        const { element, appContext } = extractInput(input);
        const { ctx, plugins } = makeContext(options, appContext);
        ctx._streaming = true;

        async function* generateAll(): AsyncGenerator<string> {
            // Phase 1: Render main page with chunk batching (4KB threshold).
            // Batched chunks are ~24x faster than per-node emission.
            let buffer = '';
            const FLUSH_THRESHOLD = 4096;

            for await (const chunk of renderToChunks(element, ctx, null, appContext)) {
                buffer += chunk;
                if (buffer.length >= FLUSH_THRESHOLD) {
                    yield buffer;
                    buffer = '';
                }
            }
            if (buffer) { yield buffer; buffer = ''; }

            // Shell produced — later failures (deferred renders) are
            // stream-phase for error routing.
            ctx._phase = 'stream';

            // Collect head from useHead() calls
            const headConfigs = ctx._headConfigs;
            if (headConfigs.length > 0) {
                ctx.addHead(renderHeadToString(headConfigs));
            }

            // Phase 2: Injected HTML from plugins
            for (const plugin of plugins) {
                const injected = plugin.server?.getInjectedHTML?.(ctx);
                if (injected) {
                    const html = typeof injected === 'string' ? injected : await injected;
                    if (html) yield html;
                }
            }

            // Boundary table (core protocol — empty renders emit nothing)
            const boundaryTable = emitBoundaryTable(ctx);
            if (boundaryTable) yield boundaryTable;

            // Phase 3: Stream async chunks — core + plugin interleaved
            for await (const chunk of streamAllAsyncChunks(ctx, plugins)) {
                yield chunk;
            }

            // Phase 4: Signal streaming complete
            yield `${scriptOpen(ctx._nonce)}window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;
        }

        return generateAll();
    }

    return {
        async render(input, options?) {
            const { element, appContext } = extractInput(input);

            // Single walk: fully-sync trees complete without suspending, async
            // trees suspend at their awaits — no sync-attempt/re-render fallback.
            const { ctx, plugins } = makeContext(options, appContext);
            let result = await renderVNodeToString(element, ctx, appContext);

            // Collect injected HTML from all plugins
            for (const plugin of plugins) {
                const injected = plugin.server?.getInjectedHTML?.(ctx);
                if (injected) {
                    result += typeof injected === 'string' ? injected : await injected;
                }
            }

            // Boundary table (core protocol — empty renders emit nothing)
            result += emitBoundaryTable(ctx);

            // Collect streaming chunks (for renderToString, await all)
            for (const plugin of plugins) {
                const chunks = plugin.server?.getStreamingChunks?.(ctx);
                if (chunks) {
                    for await (const chunk of chunks) {
                        result += chunk;
                    }
                }
            }

            // Collect head elements from useHead() calls during rendering
            const headConfigs = ctx._headConfigs;
            if (headConfigs.length > 0) {
                ctx.addHead(renderHeadToString(headConfigs));
            }

            return result;
        },

        renderChunks,

        renderStream(input, options?) {
            // Use pull-based ReadableStream backed by the chunk generator.
            // Push-based enqueueing is the worst case for WebStreams
            // throughput; pulling from a generator avoids it and provides
            // natural backpressure. (renderChunks is closure-scoped — the
            // methods are not `this`-sensitive and survive destructuring.)
            const generator = renderChunks(input, options);

            return new ReadableStream<string>({
                async pull(controller) {
                    try {
                        const { value, done } = await generator.next();
                        if (done) {
                            controller.close();
                        } else {
                            controller.enqueue(value);
                        }
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel() {
                    void generator.return(undefined);
                }
            });
        },

        async renderStreamWithCallbacks(input, callbacks, options?) {
            const { element, appContext } = extractInput(input);
            const { ctx, plugins } = makeContext(options, appContext);
            ctx._streaming = true;

            try {
                // Enable head collection
                // Phase 1: Render the shell
                let shellHtml = '';
                for await (const chunk of renderToChunks(element, ctx, null, appContext)) {
                    shellHtml += chunk;
                }
                ctx._phase = 'stream';

                // Collect head from useHead() calls
                const headConfigs = ctx._headConfigs;
                if (headConfigs.length > 0) {
                    ctx.addHead(renderHeadToString(headConfigs));
                }

                // Phase 2: Append plugin injected HTML to shell
                for (const plugin of plugins) {
                    const injected = plugin.server?.getInjectedHTML?.(ctx);
                    if (injected) {
                        shellHtml += typeof injected === 'string' ? injected : await injected;
                    }
                }

                // Boundary table (core protocol — empty renders emit nothing)
                shellHtml += emitBoundaryTable(ctx);

                shellHtml += `${scriptOpen(ctx._nonce)}window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;

                callbacks.onShellReady(shellHtml);

                // Phase 3: Stream async chunks — core + plugin interleaved
                for await (const chunk of streamAllAsyncChunks(ctx, plugins)) {
                    callbacks.onAsyncChunk(chunk);
                }

                callbacks.onComplete();
            } catch (error) {
                callbacks.onError(error as Error);
            }
        },

        renderDocument(input, options) {
            const { element, appContext } = extractInput(input);
            const engine = makeDocumentEngine(options, appContext);
            return renderDocumentImpl(engine, { element, appContext }, options);
        },

        renderDocumentChunks(input, options) {
            const { element, appContext } = extractInput(input);
            const engine = makeDocumentEngine(options, appContext);
            return renderDocumentChunksImpl(engine, { element, appContext }, options);
        },

        renderDocumentToWebStream(input, options) {
            const { element, appContext } = extractInput(input);
            const engine = makeDocumentEngine(options, appContext);
            return renderDocumentToWebStreamImpl(engine, { element, appContext }, options);
        },

        createContext(options?) {
            // No input to extract an app from — instance plugins only.
            return makeContext(options, null).ctx;
        }
    };

    /**
     * Document engine: instance + app-carried plugins, with
     * stateSerializationPlugin appended LAST by default (serializeState:
     * false opts out; a plugin named 'sigx:state' from either source
     * suppresses the default).
     */
    function makeDocumentEngine(options: DocumentOptions, appContext: AppContext | null): DocumentEngine {
        const merged = mergeSSRPlugins(instancePlugins, appContext);
        const wantsState = options.serializeState !== false;
        const hasState = merged.some(p => p.name === 'sigx:state');
        const effective = wantsState && !hasState
            ? [...merged, stateSerializationPlugin()]
            : merged;
        return {
            plugins: effective,
            streamAsyncChunks: (ctx) => streamAllAsyncChunks(ctx, effective)
        };
    }
}
