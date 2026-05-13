/**
 * Tests for hydration around <!--t--> text-boundary markers.
 *
 * Regression coverage for issue #15: a signal-driven component nested between
 * two adjacent text siblings was duplicated at the end of its parent after the
 * first reactive update, because the hydration cursor consumed the `<!--t-->`
 * separator as an empty-text placeholder instead of advancing past it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

describe('hydration text-boundary handling (#15)', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    it('does not duplicate a signal-driven component nested between two text siblings', async () => {
        // Issue #15 exact repro. Inner renders <span>{state.text}</span>;
        // outer renders <p>before <Inner/> after</p>. After hydrate, the signal
        // flips and the original SSR'd span should update in place — not be
        // re-mounted at the end of the parent.
        const Inner = component(() => {
            const state = signal({ text: '' });
            // Expose the setter via a global hook so the test can drive it.
            (globalThis as any).__issue15_setText = (v: string) => {
                state.text = v;
            };
            return () => <span class="inner">{state.text}</span>;
        }, { name: 'Inner' });

        // NOTE: explicit {' '} literals force the spaces to be discrete text
        // VNodes, mirroring the failing JSX from issue #15. Without them, the
        // surrounding whitespace is just part of the adjacent text VNode and
        // the bug doesn't trigger.
        const App = component(() => {
            return () => (
                <p class="outer">
                    before{' '}
                    <Inner />
                    {' '}after
                </p>
            );
        }, { name: 'App' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);

        const p = container.querySelector('p.outer')!;
        const originalSpan = p.querySelector('span.inner')!;
        expect(originalSpan).toBeTruthy();
        expect(p.querySelectorAll('span.inner').length).toBe(1);

        hydrate(<App />, container);
        await nextTick();

        // Flip the signal — this is what triggers the duplicate-mount bug.
        (globalThis as any).__issue15_setText('HYDRATED');
        await nextTick();

        const spansAfter = p.querySelectorAll('span.inner');
        expect(spansAfter.length).toBe(1);
        // The original SSR'd span must be the one that received the update.
        expect(spansAfter[0]).toBe(originalSpan);
        expect(originalSpan.textContent).toBe('HYDRATED');
        // Surrounding text must remain in order.
        expect(p.textContent?.replace(/\s+/g, ' ').trim()).toBe('before HYDRATED after');

        delete (globalThis as any).__issue15_setText;
    });

    it('handles a non-empty initial signal value without duplicating the span', async () => {
        // The "frozen R / live span at end" variant from the issue.
        const Inner = component(() => {
            const state = signal({ text: 'R' });
            (globalThis as any).__issue15_setText = (v: string) => {
                state.text = v;
            };
            return () => <span class="inner">{state.text}</span>;
        }, { name: 'Inner' });

        const App = component(() => {
            return () => (
                <p class="outer">
                    before{' '}
                    <Inner />
                    {' '}after
                </p>
            );
        }, { name: 'App' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        const p = container.querySelector('p.outer')!;
        const originalSpan = p.querySelector('span.inner')!;
        expect(originalSpan.textContent).toBe('R');

        hydrate(<App />, container);
        await nextTick();

        (globalThis as any).__issue15_setText('X');
        await nextTick();

        const spansAfter = p.querySelectorAll('span.inner');
        expect(spansAfter.length).toBe(1);
        expect(spansAfter[0]).toBe(originalSpan);
        expect(originalSpan.textContent).toBe('X');
        expect(p.textContent?.replace(/\s+/g, ' ').trim()).toBe('before X after');

        delete (globalThis as any).__issue15_setText;
    });

    it('handles two components between three text siblings', async () => {
        const setters: Record<string, (v: string) => void> = {};
        const makeInner = (key: string, initial: string) =>
            component(() => {
                const state = signal({ text: initial });
                setters[key] = (v) => { state.text = v; };
                return () => <span class={`i-${key}`}>{state.text}</span>;
            }, { name: `Inner_${key}` });

        const A = makeInner('a', '1');
        const B = makeInner('b', '2');

        const App = component(() => {
            return () => (
                <div class="outer">
                    x{' '}
                    <A />
                    {' '}y{' '}
                    <B />
                    {' '}z
                </div>
            );
        }, { name: 'App' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);

        const root = container.querySelector('div.outer')!;
        const originalA = root.querySelector('span.i-a')!;
        const originalB = root.querySelector('span.i-b')!;
        expect(originalA.textContent).toBe('1');
        expect(originalB.textContent).toBe('2');

        hydrate(<App />, container);
        await nextTick();

        setters.a('A!');
        setters.b('B!');
        await nextTick();

        expect(root.querySelectorAll('span.i-a').length).toBe(1);
        expect(root.querySelectorAll('span.i-b').length).toBe(1);
        expect(root.querySelector('span.i-a')).toBe(originalA);
        expect(root.querySelector('span.i-b')).toBe(originalB);
        expect(root.textContent?.replace(/\s+/g, ' ').trim()).toBe('x A! y B! z');
    });

    it('component between text siblings: plain hydrate (no signal update) preserves structure', async () => {
        // Regression guard — even without a reactive update, the initial hydrate
        // must not introduce duplicate nodes.
        const Inner = component(() => {
            const state = signal({ text: 'unchanged' });
            // Keep state referenced so the component effect runs at least once.
            return () => <span class="inner">{state.text}</span>;
        }, { name: 'Inner' });

        const App = component(() => {
            return () => (
                <p class="outer">
                    left{' '}
                    <Inner />
                    {' '}right
                </p>
            );
        }, { name: 'App' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);

        hydrate(<App />, container);
        await nextTick();

        const p = container.querySelector('p.outer')!;
        expect(p.querySelectorAll('span.inner').length).toBe(1);
        expect(p.textContent?.replace(/\s+/g, ' ').trim()).toBe('left unchanged right');
    });

    it('adjacent text VNodes with no component: real text nodes are reused, not replaced', async () => {
        // Three text children → SSR inserts two <!--t--> separators. After fix
        // #1, each text VNode must bind to its real DOM text node so a
        // reactive update targets the correct node.
        const setters: { setA?: (v: string) => void; setB?: (v: string) => void } = {};
        const App = component(() => {
            const a = signal({ value: 'one' });
            const b = signal({ value: 'two' });
            setters.setA = (v) => { a.value = v; };
            setters.setB = (v) => { b.value = v; };
            return () => (
                <p class="outer">{a.value} {b.value} three</p>
            );
        }, { name: 'App' });

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        const p = container.querySelector('p.outer')!;
        // Capture the real "two" text node up front — it must survive the update.
        const textNodes: Text[] = [];
        for (let n = p.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === Node.TEXT_NODE) {
                textNodes.push(n as Text);
            }
        }
        const twoNode = textNodes.find((n) => n.data === 'two');
        expect(twoNode).toBeTruthy();

        hydrate(<App />, container);
        await nextTick();

        setters.setA!('ONE');
        await nextTick();

        expect(p.textContent).toBe('ONE two three');
        // The "two" text node must still be the same node (we updated only "a").
        const stillThere = Array.from(p.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && (n as Text).data === 'two',
        );
        expect(stillThere).toBe(twoNode);
    });

    it('element-tag mismatch recovery: hydrate binds vnode.dom even on a mismatched cursor', async () => {
        // Synthetic case for fix #2: the SSR DOM doesn't have the element the
        // VNode expects. Hydration must (a) forward-scan for it, then (b) fall
        // back to creating a fresh element so vnode.dom is always set. A
        // subsequent signal-driven render then patches against that ref instead
        // of mounting fresh at the end of the parent.
        const Inner = component(() => {
            const state = signal({ text: 'init' });
            (globalThis as any).__issue15_setText = (v: string) => {
                state.text = v;
            };
            return () => <strong class="recovered">{state.text}</strong>;
        }, { name: 'Inner' });

        const App = component(() => {
            return () => (
                <section class="outer"><Inner /></section>
            );
        }, { name: 'App' });

        // Deliberately mismatched SSR: <section> contains text where <strong>
        // is expected. (No <!--$c:N--> trailing marker either — full mismatch.)
        container = createSSRContainer('<section class="outer">stray text</section>');

        hydrate(<App />, container);
        await nextTick();

        // Recovery: a <strong class="recovered"> must now exist inside <section>.
        const section = container.querySelector('section.outer')!;
        expect(section.querySelector('strong.recovered')).toBeTruthy();
        expect(section.querySelector('strong.recovered')!.textContent).toBe('init');

        // And the subsequent update must patch in place, not duplicate.
        (globalThis as any).__issue15_setText('updated');
        await nextTick();

        expect(section.querySelectorAll('strong.recovered').length).toBe(1);
        expect(section.querySelector('strong.recovered')!.textContent).toBe('updated');

        delete (globalThis as any).__issue15_setText;
    });
});
