/**
 * SSR Factory
 *
 * Creates an SSR instance with plugin support.
 * Plugins are registered via `.use()` and called at appropriate points
 * during server rendering and client hydration.
 *
 * @example
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 *
 * const ssr = createSSR().use(myPlugin);
 * const html = await ssr.render(<App />);
 * ```
 */

import type { SSRPlugin } from './plugin';
import type { JSXElement } from 'sigx';
import type { App, AppContext } from 'sigx';
import { Readable } from 'node:stream';
import { SSRContext, createSSRContext, SSRContextOptions, CorePendingAsync } from './server/context';
import { renderToChunks, renderVNodeToString } from './server/render-core';
import { generateStreamingScript, generateReplacementScript } from './server/streaming';
import { enableSSRHead, collectSSRHead, renderHeadToString } from './head';
import type { StreamCallbacks } from './server/types';
import { stateSerializationPlugin } from './server/state-plugin';
import {
    renderDocumentImpl,
    renderDocumentToNodeStreamImpl,
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
    // streaming — deferred renders (Suspense children, nested ssr.load
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
    if (ctx._pendingAsync.length === 0 && pluginGenerators.length === 0) return;

    // Emit the $SIGX_REPLACE bootstrap script (needed by core replacements).
    // If core async only appears mid-stream (deferred renders), the loop
    // below emits it just-in-time before the first core replacement.
    let bootstrapEmitted = false;
    if (ctx._pendingAsync.length > 0) {
        yield generateStreamingScript();
        bootstrapEmitted = true;
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
            return {
                index,
                script: generateReplacementScript(pending.id, finalHtml, extraScript || undefined, preScript || undefined)
            };
        }).catch(error => {
            if (process.env.NODE_ENV !== 'production') {
                console.error(`Error streaming async component ${pending.id}:`, error);
            }
            return {
                index,
                script: generateReplacementScript(
                    pending.id,
                    `<div style="color:red;">Error loading component</div>`
                )
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

    // Set up pump pattern for plugin generators so they can be raced alongside core
    interface PumpState {
        generator: AsyncGenerator<string>;
        done: boolean;
    }
    const pumps: PumpState[] = pluginGenerators.map(g => ({ generator: g, done: false }));

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

    function getRaceablePromises(): Promise<TaggedResult>[] {
        syncCorePromises();
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
            // Just-in-time bootstrap for core replacements that only appeared
            // mid-stream (no upfront core async existed).
            if (!bootstrapEmitted && winner.index < PUMP_BASE) {
                yield generateStreamingScript();
                bootstrapEmitted = true;
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
    /** Register a plugin */
    use(plugin: SSRPlugin): SSRInstance;

    /** Render to a complete HTML string */
    render(input: JSXElement | App, options?: SSRContextOptions | SSRContext): Promise<string>;

    /** Render to a ReadableStream with streaming support */
    renderStream(input: JSXElement | App, options?: SSRContextOptions | SSRContext): ReadableStream<string>;

    /** Render to a Node.js Readable stream (avoids WebStream overhead on Node.js) */
    renderNodeStream(input: JSXElement | App, options?: SSRContextOptions | SSRContext): import('node:stream').Readable;

    /** Render with callbacks for fine-grained streaming control */
    renderStreamWithCallbacks(
        input: JSXElement | App,
        callbacks: StreamCallbacks,
        options?: SSRContextOptions | SSRContext
    ): Promise<void>;

    /**
     * Render a COMPLETE HTML document from a template (head auto-injection,
     * state blob, async content). Default mode: 'blocking' — full content
     * inline, no placeholders or scripts (crawler/AI-agent friendly).
     */
    renderDocument(input: JSXElement | App, options: DocumentOptions): Promise<string>;

    /**
     * Stream a complete HTML document as a Node.js Readable. The `shell`
     * promise settles before any byte is produced — await it to pick the
     * HTTP status code, then pipe. Default mode: 'stream'.
     */
    renderDocumentToNodeStream(
        input: JSXElement | App,
        options: DocumentOptions
    ): { stream: import('node:stream').Readable; shell: Promise<void> };

    /** Stream a complete HTML document as UTF-8 bytes (edge-friendly). Default mode: 'stream'. */
    renderDocumentToWebStream(input: JSXElement | App, options: DocumentOptions): ReadableStream<Uint8Array>;

    /** Create a raw SSRContext with plugins pre-configured */
    createContext(options?: SSRContextOptions): SSRContext;
}

/**
 * Create an SSR instance with plugin support.
 */
export function createSSR(): SSRInstance {
    const plugins: SSRPlugin[] = [];

    function makeContext(options?: SSRContextOptions | SSRContext): SSRContext {
        // Accept an existing SSRContext (has _componentId) or create one from options
        const ctx = (options && '_componentId' in options)
            ? options as SSRContext
            : createSSRContext(options as SSRContextOptions | undefined);
        ctx._plugins = plugins;
        // Run plugin setup hooks
        for (const plugin of plugins) {
            plugin.server?.setup?.(ctx);
        }
        return ctx;
    }

    return {
        use(plugin: SSRPlugin): SSRInstance {
            plugins.push(plugin);
            return this;
        },

        async render(input, options?) {
            const { element, appContext } = extractInput(input);

            // Enable head collection during SSR rendering
            enableSSRHead();

            // Single walk: fully-sync trees complete without suspending, async
            // trees suspend at their awaits — no sync-attempt/re-render fallback.
            const ctx = makeContext(options);
            let result = await renderVNodeToString(element, ctx, appContext);

            // Collect injected HTML from all plugins
            for (const plugin of plugins) {
                const injected = plugin.server?.getInjectedHTML?.(ctx);
                if (injected) {
                    result += typeof injected === 'string' ? injected : await injected;
                }
            }

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
            const headConfigs = [...ctx._headConfigs, ...collectSSRHead()];
            if (headConfigs.length > 0) {
                ctx.addHead(renderHeadToString(headConfigs));
            }

            return result;
        },

        renderStream(input, options?) {
            const ctx = makeContext(options);
            ctx._streaming = true;
            const { element, appContext } = extractInput(input);

            // Use pull-based ReadableStream backed by an async generator.
            // Push-based enqueueing is the worst case for WebStreams
            // throughput; pulling from a generator avoids it and provides
            // natural backpressure.
            async function* generateAll() {
                enableSSRHead();

                // Phase 1: Render main page with chunk batching (4KB threshold).
                // Batched enqueues are ~24x faster than individual ones.
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

                // Collect head from useHead() calls
                const headConfigs = [...ctx._headConfigs, ...collectSSRHead()];
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

                // Phase 3: Stream async chunks — core + plugin interleaved
                for await (const chunk of streamAllAsyncChunks(ctx, plugins)) {
                    yield chunk;
                }

                // Phase 4: Signal streaming complete
                yield `<script>window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;
            }

            const generator = generateAll();

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
                }
            });
        },

        renderNodeStream(input, options?) {
            const ctx = makeContext(options);
            ctx._streaming = true;
            const { element, appContext } = extractInput(input);

            async function* generate(): AsyncGenerator<string> {
                // Enable head collection
                enableSSRHead();

                // Phase 1: Render the main page (placeholders for async components)
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

                // Collect head from useHead() calls
                const headConfigs = [...ctx._headConfigs, ...collectSSRHead()];
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

                // Phase 3: Stream async chunks — core + plugin interleaved
                for await (const chunk of streamAllAsyncChunks(ctx, plugins)) {
                    yield chunk;
                }

                // Phase 4: Signal streaming complete
                yield `<script>window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;
            }

            return Readable.from(generate(), { objectMode: true });
        },

        async renderStreamWithCallbacks(input, callbacks, options?) {
            const ctx = makeContext(options);
            ctx._streaming = true;
            const { element, appContext } = extractInput(input);

            try {
                // Enable head collection
                enableSSRHead();

                // Phase 1: Render the shell
                let shellHtml = '';
                for await (const chunk of renderToChunks(element, ctx, null, appContext)) {
                    shellHtml += chunk;
                }

                // Collect head from useHead() calls
                const headConfigs = [...ctx._headConfigs, ...collectSSRHead()];
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

                shellHtml += `<script>window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;

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
            const engine = makeDocumentEngine(options);
            return renderDocumentImpl(engine, { element, appContext }, options);
        },

        renderDocumentToNodeStream(input, options) {
            const { element, appContext } = extractInput(input);
            const engine = makeDocumentEngine(options);
            return renderDocumentToNodeStreamImpl(engine, { element, appContext }, options);
        },

        renderDocumentToWebStream(input, options) {
            const { element, appContext } = extractInput(input);
            const engine = makeDocumentEngine(options);
            return renderDocumentToWebStreamImpl(engine, { element, appContext }, options);
        },

        createContext(options?) {
            return makeContext(options);
        }
    };

    /**
     * Document engine: instance plugins, with stateSerializationPlugin
     * appended by default (serializeState: false opts out; an instance that
     * already registered it is left as-is).
     */
    function makeDocumentEngine(options: DocumentOptions): DocumentEngine {
        const wantsState = options.serializeState !== false;
        const hasState = plugins.some(p => p.name === 'sigx:state');
        const effective = wantsState && !hasState
            ? [...plugins, stateSerializationPlugin()]
            : plugins;
        return {
            plugins: effective,
            streamAsyncChunks: (ctx) => streamAllAsyncChunks(ctx, effective)
        };
    }
}
