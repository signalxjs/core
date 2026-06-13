/**
 * Tests for hydration structural-mismatch cleanup (issue #115).
 *
 * When a component's first client render diverges STRUCTURALLY from the SSR
 * DOM (e.g. SSR rendered an empty-state, client renders a populated list —
 * common when client data differs from server data, or with lazy() components
 * that hydrate after a client fetch resolved), the hydrator must bail to a
 * fresh client render for that subtree and leave NO orphaned SSR nodes behind.
 *
 * Before this fix, hydrateNode created a fresh element for the mismatching
 * client VNode but left the abandoned SSR nodes in the DOM as visible content
 * no VNode owned — producing stacked duplicate/garbage content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal, jsx } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    ssrComponentMarkers,
    nextTick,
} from './test-utils';

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('hydration structural-mismatch cleanup (#115)', () => {
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

    it('replaces an empty-state SSR subtree with a different client structure, leaving no orphans', async () => {
        // Client renders a populated table — structurally different from the
        // empty-state the server rendered.
        const ScenarioList = component(() => {
            return () => (
                <table class="scenarios">
                    <tbody>
                        <tr><td>Scenario A</td></tr>
                        <tr><td>Scenario B</td></tr>
                    </tbody>
                </table>
            );
        }, { name: 'ScenarioList' });

        // SSR rendered the empty-state placeholder (server had no data).
        const emptyState = '<div class="empty"><span class="empty-text">No scenarios yet</span></div>';
        const ssrHtml = ssrComponentMarkers(1, emptyState);
        container = createSSRContainer(ssrHtml);

        // Sanity: SSR empty-state present, no table yet.
        expect(container.querySelectorAll('.empty').length).toBe(1);
        expect(container.querySelectorAll('table.scenarios').length).toBe(0);

        const vnode = { type: ScenarioList, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        // (a) DOM contains ONLY the client tree (the table).
        expect(container.querySelectorAll('table.scenarios').length).toBe(1);
        expect(container.querySelectorAll('table.scenarios tr').length).toBe(2);
        // (b) NO orphaned SSR empty-state nodes remain.
        expect(container.querySelectorAll('.empty').length).toBe(0);
        expect(container.textContent).not.toContain('No scenarios yet');
    });

    it('patches correctly after a mismatch recovery (no duplicates on reactive update)', async () => {
        const rows = signal(['A', 'B']);
        const ScenarioList = component(() => {
            return () => (
                <ul class="list">
                    {rows.map(r => <li class="row">{r}</li>)}
                </ul>
            );
        }, { name: 'ScenarioList' });

        const emptyState = '<div class="empty"><span class="empty-text">No data</span></div>';
        container = createSSRContainer(ssrComponentMarkers(1, emptyState));

        const vnode = { type: ScenarioList, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(container.querySelectorAll('ul.list').length).toBe(1);
        expect(container.querySelectorAll('.empty').length).toBe(0);
        expect(container.querySelectorAll('li.row').length).toBe(2);

        // Reactive update must patch the recovered tree (not duplicate it).
        rows.$set(['A', 'B', 'C']);
        await nextTick();
        await wait(10);

        expect(container.querySelectorAll('ul.list').length).toBe(1);
        expect(container.querySelectorAll('li.row').length).toBe(3);
        expect(container.querySelectorAll('.empty').length).toBe(0);
    });

    it('lazy()-style: client returns null first then real content diverging from SSR — no duplication', async () => {
        // The component conditionally renders: null until data loads, then a
        // table. SSR rendered an empty-state (the server had no data). This
        // mirrors a lazy()/late-fetch hydration where the client's eventual
        // structure differs from SSR.
        const loaded = signal(false);
        const Scenarios = component(() => {
            return () => loaded.value
                ? (
                    <table class="scenarios">
                        <tbody><tr><td>Row</td></tr></tbody>
                    </table>
                )
                : null;
        }, { name: 'Scenarios' });

        const emptyState = '<div class="empty"><span class="empty-text">No scenarios yet</span></div>';
        container = createSSRContainer(ssrComponentMarkers(1, emptyState));

        const vnode = { type: Scenarios, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        // First render returned null while SSR content exists — SSR DOM kept
        // visible, no duplication yet.
        expect(container.querySelectorAll('table.scenarios').length).toBe(0);

        // Data resolves; client now renders a structure unlike the SSR DOM.
        loaded.value = true;
        await nextTick();
        await wait(20);

        // Real content present exactly once; orphaned empty-state gone.
        expect(container.querySelectorAll('table.scenarios').length).toBe(1);
        expect(container.querySelectorAll('.empty').length).toBe(0);
        expect(container.textContent).not.toContain('No scenarios yet');
    });

    it('preserves a matching subtree (no needless re-mount when structure matches)', async () => {
        // Same structure on server and client — element identity must be
        // preserved (hydration, not mount-fresh).
        const Card = component(() => {
            return () => <div class="card"><span class="title">Hello</span></div>;
        }, { name: 'Card' });

        const ssrHtml = ssrComponentMarkers(1, '<div class="card"><span class="title">Hello</span></div>');
        container = createSSRContainer(ssrHtml);
        const originalCard = container.querySelector('.card');

        const vnode = { type: Card, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();

        expect(container.querySelectorAll('.card').length).toBe(1);
        // Same DOM node — hydrated in place, not recreated.
        expect(container.querySelector('.card')).toBe(originalCard);
    });

    it('does NOT wipe sibling DOM when the SSR range is unbounded (no trailing marker)', async () => {
        // Defensive: when a component has no trailing $c: marker, its SSR DOM
        // range is unbounded within the shared parent. The mismatch cleanup
        // must NOT run in that case — removing [hydrateDom, null) would delete
        // following siblings owned by other content. Here we hydrate against
        // mismatching SSR content with NO marker, plus an unrelated sibling
        // node afterwards that must survive.
        const Widget = component(() => {
            return () => <table class="widget"><tbody><tr><td>x</td></tr></tbody></table>;
        }, { name: 'Widget' });

        // No <!--$c:N--> marker — anchor will be null during hydration.
        container = createSSRContainer(
            '<div class="ssr-widget">old</div><aside class="unrelated">keep me</aside>'
        );

        const vnode = { type: Widget, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();
        await wait(10);

        // The unrelated sibling must still be present — the cleanup must have
        // been skipped because the range was unbounded.
        expect(container.querySelectorAll('.unrelated').length).toBe(1);
        expect(container.textContent).toContain('keep me');
    });

    it('mismatch recovery for a nested child component subtree leaves no orphans', async () => {
        // Inner component whose client structure differs from SSR.
        const Inner = component(() => {
            return () => <table class="inner"><tbody><tr><td>x</td></tr></tbody></table>;
        }, { name: 'Inner' });

        const Outer = component(() => {
            return () => (
                <section class="outer">
                    {jsx(Inner, {})}
                </section>
            );
        }, { name: 'Outer' });

        // SSR: Outer(1) > section.outer > Inner(2) rendered an empty-state div.
        const innerSSR = ssrComponentMarkers(2, '<div class="empty">nothing</div>');
        const outerContent = `<section class="outer">${innerSSR}</section>`;
        container = createSSRContainer(ssrComponentMarkers(1, outerContent));

        expect(container.querySelectorAll('.empty').length).toBe(1);

        const vnode = { type: Outer, props: {}, key: null, children: [], dom: null };
        hydrate(vnode, container);
        await nextTick();
        await wait(10);

        expect(container.querySelectorAll('section.outer').length).toBe(1);
        expect(container.querySelectorAll('table.inner').length).toBe(1);
        expect(container.querySelectorAll('.empty').length).toBe(0);
        expect(container.textContent).not.toContain('nothing');
    });
});
