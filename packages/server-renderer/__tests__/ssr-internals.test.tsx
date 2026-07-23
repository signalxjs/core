import { describe, it, expect, vi } from 'vitest';
import { component, useData, defineApp } from 'sigx';
import { createSSR } from '../src/index';
import { toNodeStream } from '../src/node';
import { createSSRContext } from '../src/server/context';
import type { SSRPlugin } from '../src/plugin';
import { TestText } from './test-utils';

async function collectReadable(stream: import('node:stream').Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) {
        out += typeof chunk === 'string' ? chunk : chunk.toString();
    }
    return out;
}

describe('createSSR — plugin lifecycle', () => {
    it('calls plugin server.setup once per render with the SSRContext', async () => {
        const setup = vi.fn();
        const plugin: SSRPlugin = { name: 'test-setup', server: { setup } };
        const ssr = createSSR({ plugins: [plugin] });

        await ssr.render((TestText as any)({ text: 'a' }));
        await ssr.render((TestText as any)({ text: 'b' }));

        expect(setup).toHaveBeenCalledTimes(2);
        expect(typeof setup.mock.calls[0][0]._componentId).toBe('number');
    });

    it('createContext attaches plugins and runs setup', () => {
        const setup = vi.fn();
        const ssr = createSSR({ plugins: [{ name: 'p', server: { setup } }] });
        const ctx = ssr.createContext();
        expect(ctx._plugins).toHaveLength(1);
        expect(setup).toHaveBeenCalledWith(ctx);
    });

    it('reuses an existing SSRContext passed via options (has _componentId)', async () => {
        const ssr = createSSR();
        const ctx = createSSRContext();
        const beforeId = ctx._componentId;
        await ssr.render((TestText as any)({ text: 'x' }), ctx);
        expect(ctx._componentId).toBeGreaterThanOrEqual(beforeId);
    });
});

describe('createSSR — App instance input (extractInput / isApp)', () => {
    it('extracts the root component and AppContext from a defineApp result', async () => {
        const ssr = createSSR();
        const app = defineApp((TestText as any)({ text: 'from-app' }));
        const html = await ssr.render(app);
        expect(html).toContain('from-app');
    });
});

describe('createSSR.render — sync fast path with plugin getInjectedHTML', () => {
    it('appends synchronous injected HTML string after the shell', async () => {
        const ssr = createSSR({ plugins: [{
            name: 'inj-sync',
            server: { getInjectedHTML: () => '<script>/*injected*/</script>' }
        }] });
        const html = await ssr.render((TestText as any)({ text: 'core' }));
        expect(html).toContain('core');
        expect(html).toContain('/*injected*/');
    });

    it('awaits async injected HTML promise', async () => {
        const ssr = createSSR({ plugins: [{
            name: 'inj-async',
            server: { getInjectedHTML: () => Promise.resolve('<!-- async-inj -->') }
        }] });
        const html = await ssr.render((TestText as any)({ text: 'core' }));
        expect(html).toContain('async-inj');
    });

    it('drains plugin getStreamingChunks generators into the final string', async () => {
        async function* gen() {
            yield '<chunk-a/>';
            yield '<chunk-b/>';
        }
        const ssr = createSSR({ plugins: [{
            name: 'gs',
            server: { getStreamingChunks: () => gen() }
        }] });
        const html = await ssr.render((TestText as any)({ text: 'c' }));
        expect(html).toContain('<chunk-a/>');
        expect(html).toContain('<chunk-b/>');
    });
});

describe('createSSR.render — sync-fail → async fallback', () => {
    it('falls back to the async generator path when setup() returns a Promise', async () => {
        const AsyncComp = component(() => {
            return Promise.resolve(() => ({
                type: 'span',
                props: { class: 'async-rendered' },
                key: null,
                children: [],
                dom: null
            } as any));
        }, { name: 'AsyncComp' });

        const ssr = createSSR();
        const html = await ssr.render((AsyncComp as any)({}));
        expect(html).toContain('class="async-rendered"');
    });

    it('falls back when a component registers useData work', async () => {
        const Loaded = component(() => {
            const data = useData('internals-fallback', async () => {
                await Promise.resolve();
                return 'loaded';
            });
            return () => ({
                type: 'span',
                props: { 'data-state': data.value ?? 'pending' },
                key: null,
                children: [],
                dom: null
            } as any);
        }, { name: 'Loaded' });

        const ssr = createSSR();
        const html = await ssr.render((Loaded as any)({}));
        expect(html).toContain('data-state="loaded"');
    });
});

describe('createSSR.renderChunks via toNodeStream — async chunk streaming', () => {
    it('emits placeholders, then replacement scripts when useData resolves', async () => {
        const Async = component(() => {
            const data = useData('internals-stream', async () => {
                await Promise.resolve();
                return 'resolved';
            });
            return () => ({
                type: 'div',
                props: { class: 'async-target' },
                key: null,
                children: [data.value ?? 'placeholder'],
                dom: null
            } as any);
        }, { name: 'AsyncStream' });

        const ssr = createSSR();
        const stream = toNodeStream(ssr.renderChunks((Async as any)({})));
        const html = await collectReadable(stream);
        expect(html).toContain('data-async-placeholder');
        expect(html).toContain('$SIGX_REPLACE');
        expect(html).toContain('window.__SIGX_STREAMING_COMPLETE__');
    });

    it('emits plugin onAsyncComponentResolved augmentation in replacement script', async () => {
        const Async = component(() => {
            const ready = useData('internals-aug', async () => {
                await Promise.resolve();
                return 'resolved';
            });
            return () => ({
                type: 'span',
                props: { class: 'aug' },
                key: null,
                children: [ready.value ?? 'placeholder'],
                dom: null
            } as any);
        }, { name: 'Aug' });

        const plugin: SSRPlugin = {
            name: 'augment',
            server: {
                onAsyncComponentResolved: (_id, html) => ({ html: html + '<!--aug-->', script: 'window.AUG=1;' })
            }
        };

        const ssr = createSSR({ plugins: [plugin] });
        const stream = toNodeStream(ssr.renderChunks((Async as any)({})));
        const html = await collectReadable(stream);
        // The plugin script is appended verbatim (not JSON-escaped) per render-api
        expect(html).toContain('window.AUG=1;');
        // The augmented HTML is JSON-escaped inside the replacement <script>
        expect(html).toContain('\\u003c!--aug--\\u003e');
    });
});

describe('createSSR.renderStreamWithCallbacks — error path', () => {
    it('invokes onError when a plugin getInjectedHTML rejects', async () => {
        const onShellReady = vi.fn();
        const onAsyncChunk = vi.fn();
        const onComplete = vi.fn();
        const onError = vi.fn();

        const ssr = createSSR({ plugins: [{
            name: 'bad',
            server: { getInjectedHTML: () => Promise.reject(new Error('inj-fail')) }
        }] });

        await ssr.renderStreamWithCallbacks((TestText as any)({ text: 'x' }), {
            onShellReady, onAsyncChunk, onComplete, onError
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toBe('inj-fail');
        expect(onComplete).not.toHaveBeenCalled();
    });
});

describe('streamAllAsyncChunks — soft data error inside core promise', () => {
    it('streams the component error branch in the replacement when a fetcher rejects', async () => {
        // Server data errors are SOFT: the rejection settles the cell to
        // state 'errored' and the deferred render resolves with the
        // component's own error branch — never the red error replacement.
        const Failing = component(() => {
            const data = useData('internals-fail', async () => {
                throw new Error('load-fail');
            });
            return () => ({
                type: 'div',
                props: { class: 'placeholder-content' },
                key: null,
                children: [data.error ? `failed: ${data.error.message}` : 'loading'],
                dom: null
            } as any);
        }, { name: 'Failing' });

        const ssr = createSSR();
        const stream = toNodeStream(ssr.renderChunks((Failing as any)({})));
        const html = await collectReadable(stream);

        // The replacement carries the error branch, not the red fallback
        expect(html).toContain('$SIGX_REPLACE');
        expect(html).toContain('failed: load-fail');
        expect(html).not.toContain('Error loading component');
    });
});

describe('streamAllAsyncChunks — plugin-only streaming (no core async)', () => {
    it('drains a single plugin getStreamingChunks chunk when there is no async component work', async () => {
        async function* gen() {
            yield '<plugin-chunk-only/>';
        }

        const ssr = createSSR({ plugins: [{
            name: 'streamer',
            server: { getStreamingChunks: () => gen() }
        }] });

        const stream = toNodeStream(ssr.renderChunks((TestText as any)({ text: 'shell' })));
        const html = await collectReadable(stream);
        expect(html).toContain('<plugin-chunk-only/>');
    });

    // Regression for signalxjs/core#17 — previously, a generator that yielded
    // multiple chunks would have all but the first dropped because pumpNext
    // recursively re-queued itself from inside the resolved-value .then(),
    // draining the generator before the consumer awoke. The fix moves
    // re-queue into the consumer's race loop.
    it('drains all chunks from a single plugin getStreamingChunks generator', async () => {
        async function* gen() {
            yield '<plugin-chunk-1/>';
            yield '<plugin-chunk-2/>';
            yield '<plugin-chunk-3/>';
        }

        const ssr = createSSR({ plugins: [{
            name: 'streamer',
            server: { getStreamingChunks: () => gen() }
        }] });

        const stream = toNodeStream(ssr.renderChunks((TestText as any)({ text: 'shell' })));
        const html = await collectReadable(stream);
        expect(html).toContain('<plugin-chunk-1/>');
        expect(html).toContain('<plugin-chunk-2/>');
        expect(html).toContain('<plugin-chunk-3/>');
        // Order should be preserved within a single generator
        expect(html.indexOf('<plugin-chunk-1/>')).toBeLessThan(html.indexOf('<plugin-chunk-2/>'));
        expect(html.indexOf('<plugin-chunk-2/>')).toBeLessThan(html.indexOf('<plugin-chunk-3/>'));
    });

    it('surfaces all chunks from multiple plugin generators with per-generator order preserved', async () => {
        async function* genA() {
            yield '<a-1/>';
            yield '<a-2/>';
        }
        async function* genB() {
            yield '<b-1/>';
            yield '<b-2/>';
        }

        const ssr = createSSR({ plugins: [
            { name: 'a', server: { getStreamingChunks: () => genA() } },
            { name: 'b', server: { getStreamingChunks: () => genB() } }
        ] });

        const stream = toNodeStream(ssr.renderChunks((TestText as any)({ text: 'shell' })));
        const html = await collectReadable(stream);
        // All four chunks make it through
        expect(html).toContain('<a-1/>');
        expect(html).toContain('<a-2/>');
        expect(html).toContain('<b-1/>');
        expect(html).toContain('<b-2/>');
        // Within each generator, order is preserved
        expect(html.indexOf('<a-1/>')).toBeLessThan(html.indexOf('<a-2/>'));
        expect(html.indexOf('<b-1/>')).toBeLessThan(html.indexOf('<b-2/>'));
    });
});
