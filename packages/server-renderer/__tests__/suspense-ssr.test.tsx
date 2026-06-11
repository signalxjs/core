/**
 * Tests for Suspense/lazy server rendering: string mode awaits real content
 * inline (previously empty/fallback forever — F4); streaming mode emits the
 * fallback in a placeholder and swaps in the children once lazy deps resolve;
 * async components nested inside deferred renders are picked up mid-stream.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, lazy, Suspense, useAsync } from 'sigx';
import { createSSR, renderToString } from '../src/index';

function deferredLazy(name: string) {
    let resolveLoader!: () => void;
    const gate = new Promise<void>(r => { resolveLoader = r; });
    const Inner = component(() => {
        return () => <section class="lazy-content">{name}</section>;
    }, { name });
    const Lazy = lazy(async () => {
        await gate;
        return Inner;
    });
    return { Lazy, resolveLoader };
}

async function collectStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
    }
    return out;
}

describe('lazy() in string mode', () => {
    it('awaits the module and renders real content inline', async () => {
        const { Lazy, resolveLoader } = deferredLazy('inline-lazy');
        // Resolve the loader shortly after render starts
        setTimeout(resolveLoader, 5);

        const html = await renderToString(<div>{(Lazy as any)({})}</div>);
        expect(html).toContain('<section class="lazy-content">inline-lazy</section>');
    });

    it('renders real content inside Suspense (not the fallback)', async () => {
        const { Lazy, resolveLoader } = deferredLazy('suspense-lazy');
        setTimeout(resolveLoader, 5);

        const html = await renderToString(
            <Suspense fallback={<div class="spinner">loading…</div>}>
                {(Lazy as any)({})}
            </Suspense>
        );
        expect(html).toContain('<section class="lazy-content">suspense-lazy</section>');
        expect(html).not.toContain('spinner');
    });

    it('routes lazy loader failures through the component error fallback', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Failing = lazy(async () => {
            throw new Error('chunk failed');
        });
        const html = await renderToString(<div>{(Failing as any)({})}</div>);
        expect(html).toMatch(/<!--ssr-error:\d+-->/);
        consoleErr.mockRestore();
    });
});

describe('Suspense in streaming mode', () => {
    it('streams the fallback first, then replaces with the real children', async () => {
        const { Lazy, resolveLoader } = deferredLazy('streamed');
        setTimeout(resolveLoader, 10);

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <main>
                <Suspense fallback={<div class="spinner">loading…</div>}>
                    {(Lazy as any)({})}
                </Suspense>
            </main>
        ));

        // Fallback inside the placeholder, flushed with the shell
        const placeholderIdx = html.indexOf('data-async-placeholder="1"');
        const spinnerIdx = html.indexOf('class="spinner"');
        expect(placeholderIdx).toBeGreaterThan(-1);
        expect(spinnerIdx).toBeGreaterThan(placeholderIdx);

        // Real content arrives via the replacement script, after the shell
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(replaceIdx).toBeGreaterThan(spinnerIdx);
        expect(html).toContain('streamed');
        expect(html).toContain('sigx:ready');
    });

    it('supports nested Suspense boundaries', async () => {
        const outer = deferredLazy('outer-content');
        const inner = deferredLazy('inner-content');
        setTimeout(outer.resolveLoader, 5);
        setTimeout(inner.resolveLoader, 15);

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <Suspense fallback={<i>outer-loading</i>}>
                {(outer.Lazy as any)({})}
                <Suspense fallback={<i>inner-loading</i>}>
                    {(inner.Lazy as any)({})}
                </Suspense>
            </Suspense>
        ));

        expect(html).toContain('outer-loading');
        expect(html).toContain('outer-content');
        expect(html).toContain('inner-content');
    });

    it('streams async components nested INSIDE deferred Suspense children', async () => {
        // A component with keyed useAsync inside a Suspense boundary: its own
        // pendingAsync entry is created while the stream is already running.
        const { Lazy, resolveLoader } = deferredLazy('wrapper');
        setTimeout(resolveLoader, 5);

        const DataComp = component(() => {
            const data = useAsync('suspense-late-data', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'late-data';
            });
            return () => <p class="late">{data.value ?? 'pending'}</p>;
        }, { name: 'DataComp' });

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <Suspense fallback={<i>waiting</i>}>
                {(Lazy as any)({})}
                {(DataComp as any)({})}
            </Suspense>
        ));

        // The nested useAsync component must also be streamed and resolved
        expect(html).toContain('late-data');
    });
});
