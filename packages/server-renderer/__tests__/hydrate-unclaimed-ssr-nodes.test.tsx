/**
 * Server-rendered nodes no client vnode claims are removed during hydration.
 *
 * Regression coverage for #733: a code block the server rendered as
 * highlighted token spans (a warm highlighter cache answered synchronously)
 * hydrated as plain text on the client. The text-mismatch recovery inserted a
 * fresh text node and left the four SSR spans in place, untracked — so when
 * the client highlight landed and patched the text to a fragment of spans,
 * the `<code>` showed every line twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, signal } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

const LINES = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'];

const tokenLines = () => <>{LINES.map(l => <span data-line="">{l}</span>)}</>;

describe('hydration removes unclaimed SSR nodes (#733)', () => {
    let container: HTMLDivElement;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        cleanupScripts();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        warn.mockRestore();
    });

    it('SSR token spans hydrated as text, then patched to spans, renders each line once', async () => {
        let isClient = false;
        let highlight!: () => void;
        const Code = component(() => {
            const st = signal({ highlighted: false });
            highlight = () => { st.highlighted = true; };
            return () => (
                <pre><code>{!isClient || st.highlighted ? tokenLines() : LINES.join('\n')}</code></pre>
            );
        }, { name: 'Code' });

        container = createSSRContainer(await renderToString(<Code />));
        isClient = true;
        hydrate(<Code />, container);
        await nextTick();

        const code = container.querySelector('code')!;
        // The client's text replaces the SSR spans instead of sitting beside them.
        expect(code.querySelectorAll('[data-line]').length).toBe(0);
        expect(code.textContent).toBe(LINES.join('\n'));

        highlight();
        await nextTick();

        expect(code.querySelectorAll('[data-line]').length).toBe(4);
        expect(code.textContent).toBe(LINES.join(''));
    });

    it('SSR text hydrated as a fragment of elements leaves no stray text', async () => {
        let isClient = false;
        const Code = component(() => () => (
            <pre><code>{isClient ? tokenLines() : LINES.join('\n')}</code></pre>
        ), { name: 'Code' });

        container = createSSRContainer(await renderToString(<Code />));
        isClient = true;
        hydrate(<Code />, container);
        await nextTick();

        const code = container.querySelector('code')!;
        expect(code.querySelectorAll('[data-line]').length).toBe(4);
        expect(code.textContent).toBe(LINES.join(''));
    });

    it('a matching hydration and a later text -> fragment patch still render once', async () => {
        let highlight!: () => void;
        const Code = component(() => {
            const st = signal({ highlighted: false });
            highlight = () => { st.highlighted = true; };
            return () => <pre><code>{st.highlighted ? tokenLines() : LINES.join('\n')}</code></pre>;
        }, { name: 'Code' });

        container = createSSRContainer(await renderToString(<Code />));
        const textNode = container.querySelector('code')!.firstChild;
        hydrate(<Code />, container);
        await nextTick();

        // Nothing was unclaimed: the SSR text node is adopted, not replaced.
        expect(container.querySelector('code')!.firstChild).toBe(textNode);
        expect(warn).not.toHaveBeenCalled();

        highlight();
        await nextTick();
        expect(container.querySelectorAll('[data-line]').length).toBe(4);
    });

    it('removes SSR children of an element the client renders childless', async () => {
        let isClient = false;
        const Box = component(() => () => (
            <div class="box">{isClient ? undefined : <span class="stale">stale</span>}</div>
        ), { name: 'Box' });

        container = createSSRContainer(await renderToString(<Box />));
        expect(container.querySelector('.stale')).toBeTruthy();
        isClient = true;
        hydrate(<Box />, container);
        await nextTick();

        expect(container.querySelector('.stale')).toBeNull();
    });

    it('keeps the content of an element that owns it through innerHTML', async () => {
        let isClient = false;
        // SSR does not render innerHTML; the client sets it while hydrating
        // the element's props, before the leftover sweep runs.
        const Raw = component(() => () => (
            isClient ? <div class="raw" {...{ innerHTML: '<b>bold</b>' }} /> : <div class="raw" />
        ), { name: 'Raw' });

        container = createSSRContainer(await renderToString(<Raw />));
        isClient = true;
        hydrate(<Raw />, container);
        await nextTick();

        expect(container.querySelector('.raw b')?.textContent).toBe('bold');
    });

    it('does not remove a following sibling past the component region on an element mismatch', async () => {
        let isClient = false;
        // The client renders an extra <i> the server did not: its search walks
        // past Inner's marker onto the sibling <p>, which Inner must not take.
        const Inner = component(() => () => (
            <>
                <b>b</b>
                {isClient ? <i>i</i> : null}
            </>
        ), { name: 'Inner' });
        const App = component(() => () => (
            <div class="host">
                <Inner />
                <p class="after">after</p>
            </div>
        ), { name: 'App' });

        container = createSSRContainer(await renderToString(<App />));
        const after = container.querySelector('p.after');
        isClient = true;
        hydrate(<App />, container);
        await nextTick();

        expect(container.querySelector('p.after')).toBe(after);
        expect(container.querySelectorAll('p.after').length).toBe(1);
    });
});
