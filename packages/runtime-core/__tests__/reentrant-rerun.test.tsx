import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

/**
 * #739: a write that lands on an ancestor's render dependency while that
 * ancestor's render effect is still on the stack — a descendant's setup or
 * onMounted during the ancestor's first (inline) render, or an unmount hook
 * during its patch — must re-render the ancestor once the run unwinds, not
 * be dropped. The ancestor must still never re-enter mid-run.
 */
describe('re-entrant render notifications (#739)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    const hostClass = () => (container.firstElementChild as HTMLElement).className;

    it('a child onMounted write re-renders the host after its first render', () => {
        const theme = signal({ name: 'light' });
        let hostRenders = 0;
        const Host = component((ctx) => () => {
            hostRenders++;
            return jsx('div', { class: theme.name, children: ctx.slots.default?.() });
        });
        const Child = component((ctx) => {
            ctx.onMounted(() => { theme.name = 'dark'; });
            return () => jsx('span', {});
        });

        render(jsx(Host, { children: jsx(Child, {}) }), container);
        expect(theme.name).toBe('dark');
        expect(hostClass()).toBe('dark');
        expect(hostRenders).toBe(2);
    });

    it('a child setup write re-renders the host after its first render', () => {
        const theme = signal({ name: 'light' });
        const Host = component((ctx) => () =>
            jsx('div', { class: theme.name, children: ctx.slots.default?.() }));
        const Child = component(() => {
            theme.name = 'dark';
            return () => jsx('span', {});
        });

        render(jsx(Host, { children: jsx(Child, {}) }), container);
        expect(hostClass()).toBe('dark');
    });

    it('a grandchild onMounted write reaches the root through two running renders', () => {
        const theme = signal({ name: 'light' });
        const Host = component((ctx) => () =>
            jsx('div', { class: theme.name, children: ctx.slots.default?.() }));
        const Middle = component((ctx) => () => jsx('section', { children: ctx.slots.default?.() }));
        const Leaf = component((ctx) => {
            ctx.onMounted(() => { theme.name = 'dark'; });
            return () => jsx('span', {});
        });

        render(jsx(Host, { children: jsx(Middle, { children: jsx(Leaf, {}) }) }), container);
        expect(hostClass()).toBe('dark');
    });

    it('an unmount hook write during the parent patch re-renders the parent once, never nested (#18)', () => {
        const state = signal({ show: true, focused: 1 as number | null });
        let parentRuns = 0;
        let depth = 0;
        let maxDepth = 0;
        const Child = component((ctx) => {
            ctx.onUnmounted(() => {
                if (state.focused === 1) state.focused = null;
            });
            return () => jsx('span', { children: 'child' });
        });
        const Parent = component(() => () => {
            parentRuns++;
            depth++;
            maxDepth = Math.max(maxDepth, depth);
            try {
                return jsx('div', {
                    'data-focused': String(state.focused),
                    children: state.show ? jsx(Child, {}) : null
                });
            } finally {
                depth--;
            }
        });

        render(jsx(Parent, {}), container);
        parentRuns = 0;
        state.show = false;
        expect(maxDepth).toBe(1);
        expect(container.querySelectorAll('span').length).toBe(0);
        expect((container.firstElementChild as HTMLElement).getAttribute('data-focused')).toBe('null');
        expect(parentRuns).toBe(2);
    });

    it('a render that writes its own dependency still trips the runaway guard', () => {
        const s = signal({ v: 0 });
        const Loop = component(() => () => {
            s.v++;
            return jsx('div', { children: String(s.v) });
        });
        expect(() => render(jsx(Loop, {}), container)).toThrow(/Unbounded render flush/);
    });
});
