/**
 * Tests for <!--t--> text-boundary markers across Fragment and component
 * render-result boundaries (issue #575).
 *
 * Slot content reaches its host one level deeper than inline JSX: a slot
 * call among siblings (or a fill returning a Fragment / an array) is wrapped
 * in an anonymous Fragment by normalizeChild, and a component's render
 * function can return a raw array. The marker used to be a loop-local
 * decision in the host-element child walks, so adjacent text hidden behind
 * either boundary serialized with no separator — the browser merged it into
 * one DOM text node and hydration appended the dynamic half instead of
 * adopting it, doubling the text on the first update.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, signal, useData, Defer, type Define } from 'sigx';
import { renderToString, renderToStream } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

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

/** Decode the HTML payload of the first $SIGX_REPLACE call in the stream. */
function extractFirstReplacement(html: string): string | null {
    const m = html.match(/\$SIGX_REPLACE\(\d+, ("(?:[^"\\]|\\.)*")\)/);
    return m ? JSON.parse(m[1]) : null;
}

const Icon = component(() => {
    return () => <i class="icon" />;
}, { name: 'Icon' });

/** The #575 shape: a slot call that is NOT the sole child of its host. */
const SlotButton = component<Define.Slot<'default'>>((ctx) => {
    return () => (
        <button class="btn">
            <Icon />
            {ctx.slots.default?.()}
        </button>
    );
}, { name: 'SlotButton' });

/** The already-working shape: the slot call is the sole child (flat spread). */
const SoleSlotButton = component<Define.Slot<'default'>>((ctx) => {
    return () => <button class="sole">{ctx.slots.default?.()}</button>;
}, { name: 'SoleSlotButton' });

describe('SSR <!--t--> markers across Fragment/array boundaries (#575)', () => {
    let container: HTMLDivElement;
    const setters: Record<string, (v: any) => void> = {};

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    it('T1: slot content among siblings gets the marker and hydrates without doubling', async () => {
        const App = component(() => {
            const s = signal({ n: 5 });
            setters.t1 = (v) => { s.n = v; };
            return () => <SlotButton>count: {s.n}</SlotButton>;
        }, { name: 'App_T1' });

        const ssrHtml = await renderToString(<App />);
        // The static and dynamic text are separate VNodes inside the
        // Fragment-wrapped slot array — the marker must sit between them.
        expect(ssrHtml).toContain('count: <!--t-->5');

        container = createSSRContainer(ssrHtml);
        const button = container.querySelector('button.btn')!;
        const staticNode = Array.from(button.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data === 'count: ',
        );
        expect(staticNode).toBeTruthy();

        hydrate(<App />, container);
        await nextTick();

        setters.t1(42);
        await nextTick();

        // The #575 symptom was 'count: 542' (SSR text kept, client text appended).
        expect(button.textContent).toBe('count: 42');
        expect(button.querySelectorAll('i.icon').length).toBe(1);
        // The static text node survived hydration as the same DOM node.
        const staticAfter = Array.from(button.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data === 'count: ',
        );
        expect(staticAfter).toBe(staticNode);
    });

    it('T2: a slots-prop fill returning a Fragment gets the marker and hydrates cleanly', async () => {
        const App = component(() => {
            const s = signal({ n: 7 });
            setters.t2 = (v) => { s.n = v; };
            return () => <SoleSlotButton slots={{ default: () => <>count: {s.n}</> }} />;
        }, { name: 'App_T2' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('count: <!--t-->7');

        container = createSSRContainer(ssrHtml);
        const button = container.querySelector('button.sole')!;

        hydrate(<App />, container);
        await nextTick();

        setters.t2(8);
        await nextTick();

        expect(button.textContent).toBe('count: 8');
    });

    it('T3: sole-child slot call (flat spread) keeps its marker — regression guard', async () => {
        const App = component(() => {
            const s = signal({ n: 3 });
            setters.t3 = (v) => { s.n = v; };
            return () => <SoleSlotButton>count: {s.n}</SoleSlotButton>;
        }, { name: 'App_T3' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('count: <!--t-->3');

        container = createSSRContainer(ssrHtml);
        const button = container.querySelector('button.sole')!;

        hydrate(<App />, container);
        await nextTick();

        setters.t3(4);
        await nextTick();

        expect(button.textContent).toBe('count: 4');
    });

    it('T4: a component render-result ARRAY of texts gets markers (sync path)', async () => {
        const Pair = component(() => {
            const s = signal({ n: 5 });
            setters.t4 = (v) => { s.n = v; };
            return () => ['a: ', s.n] as any;
        }, { name: 'Pair_T4' });

        const App = component(() => {
            return () => <p class="pair">{(Pair as any)({})}</p>;
        }, { name: 'App_T4' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toMatch(/a: <!--t-->5<!--\$c:\d+-->/);

        container = createSSRContainer(ssrHtml);
        const p = container.querySelector('p.pair')!;

        hydrate(<App />, container);
        await nextTick();

        setters.t4(9);
        await nextTick();

        expect(p.textContent).toBe('a: 9');
    });

    it('T4b: a component render-result array of texts gets markers (block mode, useData)', async () => {
        const AsyncPair = component(() => {
            const d = useData('t4b-frag-marker', async () => 'done');
            return () => ['v: ', d.value ?? 'pending'] as any;
        }, { name: 'AsyncPair_T4b' });

        const html = await renderToString(<p>{(AsyncPair as any)({})}</p>);
        expect(html).toContain('v: <!--t-->done');
    });

    it('T5: an empty Fragment between two texts preserves adjacency', async () => {
        const App = component(() => {
            const s = signal({ v: 'b' });
            setters.t5 = (v) => { s.v = v; };
            return () => <p class="gap">{'a'}<></>{s.v}</p>;
        }, { name: 'App_T5' });

        const ssrHtml = await renderToString(<App />);
        // The empty Fragment emits nothing — the texts on either side are
        // still adjacent in the DOM and need their separator.
        expect(ssrHtml).toContain('>a<!--t-->b<');

        container = createSSRContainer(ssrHtml);
        const p = container.querySelector('p.gap')!;
        const aNode = Array.from(p.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data === 'a',
        );
        expect(aNode).toBeTruthy();

        hydrate(<App />, container);
        await nextTick();

        setters.t5('B!');
        await nextTick();

        expect(p.textContent).toBe('aB!');
        const aAfter = Array.from(p.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data === 'a',
        );
        expect(aAfter).toBe(aNode);
    });

    it('T6: component output BEGINNING with bare text after a text sibling gets the marker', async () => {
        const TextComp = component(() => {
            const s = signal({ n: 5 });
            setters.t6 = (v) => { s.n = v; };
            return () => s.n as any;
        }, { name: 'TextComp_T6' });

        const App = component(() => {
            return () => <p class="lead">{'a'}<TextComp /></p>;
        }, { name: 'App_T6' });

        const ssrHtml = await renderToString(<App />);
        // Components emit only a TRAILING <!--$c:N--> anchor, so their leading
        // bare text would merge with a preceding text sibling without a marker.
        expect(ssrHtml).toMatch(/>a<!--t-->5<!--\$c:\d+--></);

        container = createSSRContainer(ssrHtml);
        const p = container.querySelector('p.lead')!;

        hydrate(<App />, container);
        await nextTick();

        setters.t6(42);
        await nextTick();

        expect(p.textContent).toBe('a42');
    });

    it('T6b: text AFTER a component needs no marker — the trailing anchor separates', async () => {
        const TextComp = component(() => {
            return () => 5 as any;
        }, { name: 'TextComp_T6b' });

        const html = await renderToString(<p>{(TextComp as any)({})}b</p>);
        // <!--$c:N--> already breaks DOM text merging; a marker would be noise.
        expect(html).toMatch(/5<!--\$c:\d+-->b/);
        expect(html).not.toContain('<!--t-->');
    });

    it('T7: streaming emits the marker inside slot content and pre-data array renders', async () => {
        const App = component(() => {
            const s = signal({ n: 5 });
            return () => <SlotButton>count: {s.n}</SlotButton>;
        }, { name: 'App_T7' });

        const streamed = await collectStream(renderToStream(<App />));
        expect(streamed).toContain('count: <!--t-->5');

        const AsyncArr = component(() => {
            const d = useData('t7-stream-arr', async () => 'done');
            return () => ['x: ', d.value ?? 'pending'] as any;
        }, { name: 'AsyncArr_T7' });

        const asyncStreamed = await collectStream(renderToStream(<div>{(AsyncArr as any)({})}</div>));
        // Pre-data placeholder render walks the raw array — marker required.
        expect(asyncStreamed).toContain('x: <!--t-->pending');
    });

    it('T8: a sync-walk bail-out mid-fragment does not leave a spurious marker behind', async () => {
        const Span = component(() => {
            return () => <span class="s">tail</span>;
        }, { name: 'Span_T8' });

        // The fragment's 'a' renders in the sync fast path, then <Span/> forces
        // a bail-out and rollback; the generator re-render must not believe
        // text was already emitted.
        const html = await renderToString(
            <div class="bail"><>{'a'}<Span /></> b</div>
        );
        expect(html).toContain('<div class="bail">a<span');
        expect(html).not.toContain('<!--t-->a');
    });

    it('T10: a deferred render whose result is an ARRAY streams real content with markers', async () => {
        const AsyncArr = component(() => {
            const d = useData('t10-deferred-arr', async () => 'done');
            return () => ['y: ', d.value ?? 'pending'] as any;
        }, { name: 'AsyncArr_T10' });

        const streamed = await collectStream(renderToStream(<div>{(AsyncArr as any)({})}</div>));
        const payload = extractFirstReplacement(streamed);
        // Before the fragmentOf() fix the walker had no branch for a raw
        // array — the $SIGX_REPLACE payload was empty.
        expect(payload).toBeTruthy();
        expect(payload!).toContain('y: ');
        expect(payload!).toContain('done');
        expect(payload!).toContain('y: <!--t-->done');
    });

    it('T10b: Defer keeps cross-item text adjacency in its single replacement', async () => {
        const streamed = await collectStream(renderToStream(
            <div class="wrap">
                <Defer fallback={<span>wait</span>}>{'a: '}{5}</Defer>
            </div>
        ));
        const payload = extractFirstReplacement(streamed);
        expect(payload).toBeTruthy();
        // Leading <!----> mirrors the client Defer render shape; the two text
        // items were previously rendered in separate walks with no marker.
        expect(payload!).toContain('<!---->a: <!--t-->5');
    });
});

describe('__DEV__ hydration warning for text mismatches (T9)', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        vi.restoreAllMocks();
    });

    const textWarnings = (spy: ReturnType<typeof vi.spyOn>) =>
        spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[Hydrate] Expected a text node'));

    it('fires when a non-empty Text vnode cannot adopt a text node', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const App = component(() => {
            return () => <p class="m">{'hello'}<b>x</b></p>;
        }, { name: 'App_T9a' });

        // SSR DOM is missing the text node entirely — the cursor lands on <b>.
        container = createSSRContainer('<p class="m"><b>x</b></p>');
        hydrate(<App />, container);
        await nextTick();

        expect(textWarnings(warn).length).toBeGreaterThan(0);
        // Recovery still inserts the text so the client tree is complete.
        expect(container.querySelector('p.m')!.textContent).toBe('hellox');
    });

    it('stays silent for the <!--t--> empty-text stand-in contract', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const App = component(() => {
            return () => <p class="e">{'x'}{''}{' y'}</p>;
        }, { name: 'App_T9b' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        hydrate(<App />, container);
        await nextTick();

        expect(textWarnings(warn)).toEqual([]);
        expect(container.querySelector('p.e')!.textContent).toBe('x y');
    });

    it('stays silent on a clean slot-content round trip', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const App = component(() => {
            const s = signal({ n: 5 });
            return () => <SlotButton>count: {s.n}</SlotButton>;
        }, { name: 'App_T9c' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        hydrate(<App />, container);
        await nextTick();

        expect(textWarnings(warn)).toEqual([]);
    });
});
