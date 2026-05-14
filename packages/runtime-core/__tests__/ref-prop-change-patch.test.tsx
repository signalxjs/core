import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

/**
 * When the value of a `ref` prop changes across re-renders, the renderer
 * should null the old ref and call the new ref with the current node /
 * exposed value. Previously the patch path explicitly skipped `ref` in
 * the prop-diff loop, so swapping refs left the old one holding a stale
 * reference and the new one was never called.
 */
describe('ref prop change during patch', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('swaps element function refs (old gets null, new gets element)', () => {
        const r1 = vi.fn();
        const r2 = vi.fn();
        const which = signal<1 | 2>(1);

        const App = component(() => () => jsx('div', { ref: which.value === 1 ? r1 : r2 }));
        render(jsx(App, {}), container);

        const div1 = container.querySelector('div');
        expect(r1).toHaveBeenCalledTimes(1);
        expect(r1).toHaveBeenCalledWith(div1);
        expect(r2).not.toHaveBeenCalled();

        r1.mockClear();
        which.value = 2;

        const div2 = container.querySelector('div');
        // old ref nulled, new ref called with the (same) element
        expect(r1).toHaveBeenCalledTimes(1);
        expect(r1).toHaveBeenCalledWith(null);
        expect(r2).toHaveBeenCalledTimes(1);
        expect(r2).toHaveBeenCalledWith(div2);
    });

    it('clears element ref when ref prop is removed', () => {
        const r = vi.fn();
        const on = signal(true);
        const App = component(() => () => jsx('div', on.value ? { ref: r } : {}));
        render(jsx(App, {}), container);
        expect(r).toHaveBeenCalledWith(container.querySelector('div'));

        r.mockClear();
        on.value = false;
        expect(r).toHaveBeenCalledTimes(1);
        expect(r).toHaveBeenCalledWith(null);
    });

    it('sets element ref when ref prop is added', () => {
        const r = vi.fn();
        const on = signal(false);
        const App = component(() => () => jsx('div', on.value ? { ref: r } : {}));
        render(jsx(App, {}), container);
        expect(r).not.toHaveBeenCalled();

        on.value = true;
        const div = container.querySelector('div');
        expect(r).toHaveBeenCalledTimes(1);
        expect(r).toHaveBeenCalledWith(div);
    });

    it('swaps element object refs (old.current cleared, new.current set)', () => {
        const o1: { current: any } = { current: null };
        const o2: { current: any } = { current: null };
        const which = signal<1 | 2>(1);
        const App = component(() => () => jsx('div', { ref: which.value === 1 ? o1 : o2 }));
        render(jsx(App, {}), container);

        const div1 = container.querySelector('div');
        expect(o1.current).toBe(div1);
        expect(o2.current).toBeNull();

        which.value = 2;
        const div2 = container.querySelector('div');
        expect(o1.current).toBeNull();
        expect(o2.current).toBe(div2);
    });

    it('swaps component refs (old gets null, new gets exposed value)', () => {
        const r1 = vi.fn();
        const r2 = vi.fn();
        const which = signal<1 | 2>(1);

        const Child = component((ctx) => {
            (ctx.expose as any)({ kind: 'child-api' });
            return () => jsx('span', {});
        });
        const App = component(() => () => jsx(Child, { ref: which.value === 1 ? r1 : r2 }));
        render(jsx(App, {}), container);

        expect(r1).toHaveBeenCalledTimes(1);
        expect(r1.mock.calls[0][0]).toEqual({ kind: 'child-api' });
        expect(r2).not.toHaveBeenCalled();

        r1.mockClear();
        which.value = 2;

        expect(r1).toHaveBeenCalledTimes(1);
        expect(r1).toHaveBeenCalledWith(null);
        expect(r2).toHaveBeenCalledTimes(1);
        expect(r2.mock.calls[0][0]).toEqual({ kind: 'child-api' });
    });

    it('new element ref observes updated props (ref runs after patch)', () => {
        const which = signal<1 | 2>(1);
        const seenId: string[] = [];
        const r2 = vi.fn((el: HTMLElement | null) => {
            if (el) seenId.push(el.id);
        });

        const App = component(() => () => jsx('div', {
            id: which.value === 1 ? 'old-id' : 'new-id',
            ref: which.value === 1 ? null : r2,
        }));
        render(jsx(App, {}), container);

        which.value = 2;

        expect(r2).toHaveBeenCalledTimes(1);
        expect(seenId).toEqual(['new-id']);
    });
});
