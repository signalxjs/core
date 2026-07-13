/**
 * Tests for useStream() — progressive text streaming (LLM-token-style):
 * ordered $SIGX_APPEND chunks in streaming mode, final markup replacement,
 * blocking-mode inlining, script-breakout safety, interleaving with normal
 * async components, and hydration restoring the final text.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, useData, useStream } from 'sigx';
import { createSSR, stateSerializationPlugin, renderToString } from '../src/index';
import { hydrateComponent } from '../src/client/hydrate-component';
import {
    createSSRContainer,
    cleanupContainer,
    ssrComponentMarkers,
    nextTick
} from './test-utils';

async function* tokens(parts: string[], delayMs = 1) {
    for (const part of parts) {
        await new Promise(r => setTimeout(r, delayMs));
        yield part;
    }
}

function makeAnswerComponent(parts: string[]) {
    return component(() => {
        const answer = useStream('answer', () => tokens(parts));
        return () => <div class="answer">{answer.value}</div>;
    }, { name: 'Answer' });
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

describe('useStream — blocking/string mode', () => {
    it('drains the source and renders the final text inline', async () => {
        const Answer = makeAnswerComponent(['Hello', ', ', 'world']);
        const html = await renderToString((Answer as any)({}));
        expect(html).toContain('<div class="answer">Hello, world</div>');
        expect(html).not.toContain('$SIGX_APPEND');
    });
});

describe('useStream — streaming mode', () => {
    it('appends tokens in order, then replaces with the final markup', async () => {
        const Answer = makeAnswerComponent(['alpha-', 'beta-', 'gamma']);
        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream((Answer as any)({})));

        // Bootstrap before any append
        const bootstrapIdx = html.indexOf('window.$SIGX_APPEND');
        expect(bootstrapIdx).toBeGreaterThan(-1);

        // Tokens appear as ordered append scripts
        const a = html.indexOf('$SIGX_APPEND(1, "alpha-")');
        const b = html.indexOf('$SIGX_APPEND(1, "beta-")');
        const c = html.indexOf('$SIGX_APPEND(1, "gamma")');
        expect(a).toBeGreaterThan(bootstrapIdx);
        expect(b).toBeGreaterThan(a);
        expect(c).toBeGreaterThan(b);

        // Final replacement carries the fully-rendered markup, after appends
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(replaceIdx).toBeGreaterThan(c);
        expect(html).toContain('alpha-beta-gamma');
        expect(html).toContain('sigx:ready');
    });

    it('escapes script-breakout sequences in tokens', async () => {
        const Answer = makeAnswerComponent(['</script><script>alert(1)//']);
        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream((Answer as any)({})));

        const appendIdx = html.indexOf('$SIGX_APPEND(1,');
        const appendChunk = html.slice(appendIdx, html.indexOf('</script>', appendIdx) + 9);
        expect(appendChunk).not.toContain('</script><script>alert');
        expect(appendChunk).toContain('\\u003c/script\\u003e');
    });

    it('interleaves with normal keyed useData components', async () => {
        const Answer = makeAnswerComponent(['tok1', 'tok2']);
        const Data = component(() => {
            const data = useData('stream-text-data', async () => {
                await new Promise(r => setTimeout(r, 5));
                return 'loaded';
            });
            return () => <p class="data">{data.value ?? 'pending'}</p>;
        }, { name: 'Data' });

        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(
            <main>
                {(Answer as any)({})}
                {(Data as any)({})}
            </main>
        ));

        expect(html).toContain('$SIGX_APPEND(1, "tok1")');
        expect(html).toContain('tok1tok2');
        expect(html).toContain('loaded');
        // Both placeholders present in the shell
        expect(html).toContain('data-async-placeholder="1"');
        expect(html).toContain('data-async-placeholder="2"');
    });

    it('captures the final text for state serialization (preScript before replace)', async () => {
        const Answer = makeAnswerComponent(['final ', 'text']);
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await collectStream(ssr.renderStream((Answer as any)({})));

        const stateIdx = html.indexOf('"answer":"final text"');
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(stateIdx).toBeGreaterThan(-1);
        expect(stateIdx).toBeLessThan(replaceIdx);
    });
});

describe('useStream — hydration', () => {
    it('restores the final streamed text without re-running the source', async () => {
        const sourceSpy = vi.fn();
        let restored: string | undefined;

        const Answer = component(() => {
            const answer = useStream('answer', () => {
                sourceSpy();
                return tokens(['should', 'not', 'run']);
            });
            restored = answer.value;
            return () => <div class="answer">{answer.value}</div>;
        }, { name: 'Answer' });

        // Request-global blob, keyed by the useStream key (no component-id nesting)
        (globalThis as any).__SIGX_ASYNC__ = { answer: 'restored stream text' };
        const container = createSSRContainer(
            ssrComponentMarkers(1, '<div class="answer">restored stream text</div>')
        );

        try {
            hydrateComponent(
                { type: Answer, props: {}, key: null, children: [], dom: null },
                container.firstChild, container
            );
            await nextTick();

            expect(restored).toBe('restored stream text');
            expect(sourceSpy).not.toHaveBeenCalled();
            expect(container.querySelector('.answer')!.textContent).toBe('restored stream text');
        } finally {
            cleanupContainer(container);
            delete (globalThis as any).__SIGX_ASYNC__;
        }
    });
});
