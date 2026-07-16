/**
 * Tests for Defer/lazy server rendering: string mode awaits real content
 * inline and renders Defer's constant [comment, ...children] shape; streaming
 * mode emits the fallback in a placeholder and swaps in ONE replacement
 * (with a leading <!----> mirroring the client render shape) once everything
 * pending beneath the boundary — lazy chunks AND keyed useData reads —
 * resolves.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, lazy, Defer, useData } from 'sigx';
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

/** Decode the HTML payload of the $SIGX_REPLACE call for boundary `id`. */
function extractReplacement(html: string, id: number): string | null {
    const m = html.match(new RegExp(`\\$SIGX_REPLACE\\(${id}, ("(?:[^"\\\\]|\\\\.)*")\\)`));
    return m ? JSON.parse(m[1]) : null;
}

describe('lazy() in string mode', () => {
    it('awaits the module and renders real content inline', async () => {
        const { Lazy, resolveLoader } = deferredLazy('inline-lazy');
        // Resolve the loader shortly after render starts
        setTimeout(resolveLoader, 5);

        const html = await renderToString(<div>{(Lazy as any)({})}</div>);
        expect(html).toContain('<section class="lazy-content">inline-lazy</section>');
    });

    it('renders real content inside Defer with the leading comment (not the fallback)', async () => {
        const { Lazy, resolveLoader } = deferredLazy('defer-lazy');
        setTimeout(resolveLoader, 5);

        const html = await renderToString(
            <Defer fallback={<div class="spinner">loading…</div>}>
                {(Lazy as any)({})}
            </Defer>
        );
        // Defer's render shape is CONSTANT: [fallback-or-comment, ...children].
        // In string mode the null fallback slot renders as a comment node
        // directly before the children markup.
        expect(html).toContain('<!----><section class="lazy-content">defer-lazy</section>');
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

describe('Defer in streaming mode', () => {
    it('streams the fallback first, then replaces with the real children', async () => {
        const { Lazy, resolveLoader } = deferredLazy('streamed');
        setTimeout(resolveLoader, 10);

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <main>
                <Defer fallback={<div class="spinner">loading…</div>}>
                    {(Lazy as any)({})}
                </Defer>
            </main>
        ));

        // Fallback inside the placeholder, flushed with the shell
        const placeholderIdx = html.indexOf('data-async-placeholder="1"');
        const spinnerIdx = html.indexOf('class="spinner"');
        expect(placeholderIdx).toBeGreaterThan(-1);
        expect(spinnerIdx).toBeGreaterThan(placeholderIdx);

        // Real content arrives via the replacement script, after the shell —
        // its HTML leads with <!----> (the client Defer's null fallback slot)
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(replaceIdx).toBeGreaterThan(spinnerIdx);
        const replacement = extractReplacement(html, 1);
        expect(replacement).not.toBeNull();
        expect(replacement!.startsWith('<!---->')).toBe(true);
        expect(replacement).toContain('streamed');
        expect(html).toContain('sigx:ready');
    });

    it('supports nested Defer boundaries', async () => {
        const outer = deferredLazy('outer-content');
        const inner = deferredLazy('inner-content');
        setTimeout(outer.resolveLoader, 5);
        setTimeout(inner.resolveLoader, 15);

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <Defer fallback={<i>outer-loading</i>}>
                {(outer.Lazy as any)({})}
                <Defer fallback={<i>inner-loading</i>}>
                    {(inner.Lazy as any)({})}
                </Defer>
            </Defer>
        ));

        expect(html).toContain('outer-loading');
        expect(html).toContain('outer-content');
        expect(html).toContain('inner-content');
    });

    it('awaits keyed useData reads inside a streaming Defer — ONE replacement, no nested placeholder', async () => {
        // The headline behavior: keyed reads beneath a streaming <Defer> are
        // awaited INSIDE the deferred render (block mode) instead of spawning
        // their own nested placeholders — the boundary's single replacement
        // carries the resolved data.
        const DataComp = component(() => {
            const data = useData('defer-inside-data', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'defer-loaded';
            });
            return () => <p class="data">{data.value ?? 'pending'}</p>;
        }, { name: 'DataComp' });

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <main>
                <Defer fallback={<i class="wait">waiting</i>}>
                    <DataComp />
                </Defer>
            </main>
        ));

        // Shell: the fallback streams inside the Defer's placeholder
        const placeholderIdx = html.indexOf('data-async-placeholder="1"');
        const fallbackIdx = html.indexOf('class="wait"');
        expect(placeholderIdx).toBeGreaterThan(-1);
        expect(fallbackIdx).toBeGreaterThan(placeholderIdx);

        // Exactly ONE placeholder element and ONE replacement — the boundary's
        expect([...html.matchAll(/data-async-placeholder="\d+"/g)]).toHaveLength(1);
        const replaceCalls = [...html.matchAll(/\$SIGX_REPLACE\((\d+),/g)];
        expect(replaceCalls).toHaveLength(1);
        expect(replaceCalls[0][1]).toBe('1');

        // The replacement leads with <!----> and contains the RESOLVED data —
        // the keyed read did not nest its own placeholder
        const replacement = extractReplacement(html, 1)!;
        expect(replacement.startsWith('<!---->')).toBe(true);
        expect(replacement).toContain('defer-loaded');
        expect(replacement).not.toContain('data-async-placeholder');
        expect(replacement).not.toContain('pending');
    });

    it('control: the same async component NOT under Defer streams its own placeholder', async () => {
        const DataComp = component(() => {
            const data = useData('defer-control-data', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'control-loaded';
            });
            return () => <p class="data">{data.value ?? 'pending'}</p>;
        }, { name: 'DataComp' });

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <main>
                <DataComp />
            </main>
        ));

        // Without a Defer boundary the component streams itself: pending arm
        // in its own placeholder, then its own replacement with the data
        const placeholderIdx = html.indexOf('data-async-placeholder="1"');
        const pendingIdx = html.indexOf('pending');
        expect(placeholderIdx).toBeGreaterThan(-1);
        expect(pendingIdx).toBeGreaterThan(placeholderIdx);
        const replacement = extractReplacement(html, 1)!;
        expect(replacement).toContain('control-loaded');
        // No Defer here — plain component replacement, no leading comment
        expect(replacement.startsWith('<!---->')).toBe(false);
    });

    it('streams lazy chunks AND keyed useData reads under one boundary in a single replacement', async () => {
        // Port of the old "async components nested INSIDE deferred children"
        // case: previously the keyed read spawned its own mid-stream
        // placeholder; now the Defer's replacement resolves it inline.
        const { Lazy, resolveLoader } = deferredLazy('wrapper');
        setTimeout(resolveLoader, 5);

        const DataComp = component(() => {
            const data = useData('defer-late-data', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'late-data';
            });
            return () => <p class="late">{data.value ?? 'pending'}</p>;
        }, { name: 'DataComp' });

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <Defer fallback={<i>waiting</i>}>
                {(Lazy as any)({})}
                <DataComp />
            </Defer>
        ));

        // Both the lazy chunk's content and the resolved keyed data arrive in
        // the boundary's single replacement
        const replaceCalls = [...html.matchAll(/\$SIGX_REPLACE\((\d+),/g)];
        expect(replaceCalls).toHaveLength(1);
        const replacement = extractReplacement(html, 1)!;
        expect(replacement.startsWith('<!---->')).toBe(true);
        expect(replacement).toContain('wrapper');
        expect(replacement).toContain('late-data');
        expect(replacement).not.toContain('data-async-placeholder');
    });
});

describe('Defer in string (blocking) mode with keyed useData', () => {
    it('renders inline with resolved data, the leading comment, and no fallback', async () => {
        const DataComp = component(() => {
            const data = useData('defer-string-data', async () => {
                await new Promise(r => setTimeout(r, 5));
                return 'string-loaded';
            });
            return () => <p class="data">{data.value ?? 'pending'}</p>;
        }, { name: 'DataComp' });

        const html = await renderToString(
            <Defer fallback={<i class="wait">waiting</i>}>
                <DataComp />
            </Defer>
        );

        // Blocking mode awaits the keyed read inline — no streaming machinery
        expect(html).not.toContain('data-async-placeholder');
        expect(html).not.toContain('waiting');
        expect(html).not.toContain('pending');
        // Constant shape: the null fallback slot is a comment node before the
        // resolved children
        expect(html.startsWith('<!---->')).toBe(true);
        expect(html).toContain('<p class="data">string-loaded</p>');
    });
});
