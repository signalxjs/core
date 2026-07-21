/**
 * Tests for hydrating against a whitespace-formatted mount container.
 *
 * `hydrate()` passes `container.firstChild` to the walk verbatim, and
 * `hydrateNode`'s skip loop advances past COMMENT nodes only. So when the host
 * page pretty-prints its mount container —
 *
 *     <div id="app">
 *         <div class="card">…</div><!--$c:1-->
 *     </div>
 *
 * — the component's SSR range starts at a whitespace TEXT node. Before this
 * fix `subtreeMatchesSSRDom` treated ANY leading text as a structural
 * mismatch, so the hydrator discarded the whole server-rendered subtree and
 * re-rendered it on the client: hydration entirely defeated by indentation.
 *
 * Whitespace-only text is a formatting artifact of the surrounding markup, not
 * content SSR rendered for the component, so it must be skipped. Text with
 * VISIBLE content still means SSR really did render leading text where the
 * client wants an element — that is the #115 orphan case and must still bail.
 *
 * This file's contract is "do NOT bail"; `hydrate-mismatch-cleanup.test.tsx`
 * owns the complementary "bail correctly" contract (#115/#116).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    ssrComponentMarkers,
    nextTick,
} from './test-utils';

/** Did the hydrator bail and re-render this component from scratch? */
function bailed(spy: ReturnType<typeof vi.spyOn>): boolean {
    return spy.mock.calls.some(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Structural mismatch')
    );
}

describe('hydration against a whitespace-formatted container', () => {
    let container: HTMLDivElement;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        cleanupScripts();
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        consoleWarnSpy.mockRestore();
    });

    it('hydrates in place when the container indents the root element', async () => {
        const Card = component(() => {
            return () => (
                <div class="card"><span class="title">Hello</span></div>
            );
        });

        const ssr = '<div class="card"><span class="title">Hello</span></div>';
        container = createSSRContainer('\n    ' + ssrComponentMarkers(1, ssr) + '\n');

        // Identity is the discriminating signal: a bail removes the SSR range
        // and mounts fresh, so the original node would NOT survive.
        const original = container.querySelector('.card');
        expect(original).not.toBeNull();

        const vnode = { type: Card, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(container.querySelector('.card')).toBe(original);
        expect(bailed(consoleWarnSpy)).toBe(false);
        expect(container.querySelectorAll('.card').length).toBe(1);
        expect(container.textContent).toContain('Hello');
    });

    it('keeps the hydrated tree patchable after indented hydration', async () => {
        const rows = signal(['A', 'B']);
        const List = component(() => {
            return () => (
                <ul class="list">
                    {rows.map(r => <li class="row">{r}</li>)}
                </ul>
            );
        });

        const ssr = '<ul class="list"><li class="row">A</li><li class="row">B</li></ul>';
        container = createSSRContainer('\n  ' + ssrComponentMarkers(1, ssr) + '\n');

        const originalList = container.querySelector('ul.list');

        const vnode = { type: List, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(container.querySelector('ul.list')).toBe(originalList);
        expect(bailed(consoleWarnSpy)).toBe(false);

        // A reactive update must patch the hydrated tree, not duplicate it.
        rows.$set(['A', 'B', 'C']);
        await nextTick();

        expect(container.querySelectorAll('ul.list').length).toBe(1);
        expect(container.querySelectorAll('li.row').length).toBe(3);
    });

    it('hydrates a nested component whose SSR content is indented inside its parent', async () => {
        const Inner = component(() => {
            return () => <div class="inner">x</div>;
        });
        const Outer = component(() => {
            return () => (
                <section class="outer"><Inner /></section>
            );
        });

        const innerSsr = ssrComponentMarkers(2, '<div class="inner">x</div>');
        const ssr = `<section class="outer">\n    ${innerSsr}\n  </section>`;
        container = createSSRContainer('\n  ' + ssrComponentMarkers(1, ssr) + '\n');

        const originalInner = container.querySelector('.inner');
        expect(originalInner).not.toBeNull();

        const vnode = { type: Outer, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(container.querySelector('.inner')).toBe(originalInner);
        expect(bailed(consoleWarnSpy)).toBe(false);
        expect(container.querySelectorAll('.inner').length).toBe(1);
    });

    it('still bails on leading NBSP — it is visible content, not indentation', async () => {
        // JS `\s` matches NBSP, so a naive /\S/ whitespace test would skip a
        // server-rendered `&nbsp;` and abandon it as a visible orphan. Only
        // HTML's ASCII whitespace counts as formatting.
        const Table = component(() => {
            return () => (
                <table class="t"><tbody><tr><td>row</td></tr></tbody></table>
            );
        });

        container = createSSRContainer(
            ssrComponentMarkers(1, ' <div class="empty">none</div>')
        );

        // Guard the fixture itself: if the NBSP is ever normalised to an ASCII
        // space by an editor or the toolchain, this test would silently start
        // asserting the plain-whitespace case instead.
        expect(container.textContent).toContain(' ');

        const vnode = { type: Table, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(bailed(consoleWarnSpy)).toBe(true);
        expect(container.querySelectorAll('table.t').length).toBe(1);
        expect(container.textContent).not.toContain(' ');
        expect(container.querySelectorAll('.empty').length).toBe(0);
    });

    it('still bails when SSR rendered MEANINGFUL leading text (#115 orphan case)', async () => {
        // Negative control. If someone widens the whitespace carve-out into a
        // blanket "skip all text", this test fails — visible SSR text would be
        // abandoned in the DOM as content no VNode owns.
        const Table = component(() => {
            return () => (
                <table class="t"><tbody><tr><td>row</td></tr></tbody></table>
            );
        });

        container = createSSRContainer(
            ssrComponentMarkers(1, 'Loading…<div class="empty">none</div>')
        );

        const vnode = { type: Table, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(bailed(consoleWarnSpy)).toBe(true);
        expect(container.querySelectorAll('table.t').length).toBe(1);
        expect(container.textContent).not.toContain('Loading');
        expect(container.querySelectorAll('.empty').length).toBe(0);
    });
});
