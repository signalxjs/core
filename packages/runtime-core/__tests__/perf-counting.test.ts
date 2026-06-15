import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { signal, batch } from '@sigx/reactivity';
import { createRenderer } from '../src/renderer';
import { jsx, Fragment } from '../src/jsx-runtime';
import { component } from '../src/component';
import { createCountingNodeOps, makeRows, type Row } from './helpers/perf-harness';

/**
 * Deterministic renderer-cost proofs: exact component render counts and
 * exact host DOM-op counts for canonical update scenarios.
 *
 * These are the regression locks for the update propagation work (#59).
 * Assertions marked `STAGE n` pin today's cost and are tightened by that
 * stage in the same commit that improves it.
 */

function rowList(rows: Row[], selectedId?: number) {
    return jsx(Fragment, {
        children: rows.map(r =>
            jsx('li', {
                key: r.id,
                class: r.id === selectedId ? 'selected' : 'row',
                children: r.label,
            })
        ),
    });
}

describe('renderer op counts (mock host)', () => {
    let ops: ReturnType<typeof createCountingNodeOps>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: any;

    beforeEach(() => {
        ops = createCountingNodeOps();
        renderer = createRenderer(ops as any);
        container = ops.createContainer();
    });

    it('partial update (every 10th of 1000 rows) only sets text', () => {
        const rows = makeRows(1000);
        renderer.render(rowList(rows) as any, container);
        ops.reset();

        const updated = rows.map((r, i) =>
            i % 10 === 0 ? { ...r, label: `${r.label} !` } : r
        );
        renderer.render(rowList(updated) as any, container);

        const counts = ops.counts();
        expect(counts.setText).toBe(100);
        expect(counts.createElement).toBe(0);
        expect(counts.insert).toBe(0);
        expect(counts.remove).toBe(0);
    });

    it('select row (class change on 2 of 1000 rows) only patches 2 props', () => {
        const rows = makeRows(1000);
        renderer.render(rowList(rows, 1) as any, container);
        ops.reset();

        renderer.render(rowList(rows, 2) as any, container);

        const counts = ops.counts();
        expect(counts.patchProp).toBe(2);
        expect(counts.createElement).toBe(0);
        expect(counts.insert).toBe(0);
        expect(counts.remove).toBe(0);
        expect(counts.setText).toBe(0);
    });

    it('swap rows 2 and 98 of 100 moves nodes without creating or removing', () => {
        const rows = makeRows(100);
        renderer.render(rowList(rows) as any, container);
        ops.reset();

        const swapped = rows.slice();
        [swapped[1], swapped[97]] = [swapped[97], swapped[1]];
        renderer.render(rowList(swapped) as any, container);

        const counts = ops.counts();
        expect(counts.createElement).toBe(0);
        expect(counts.remove).toBe(0);
        expect(counts.setText).toBe(0);
        // Keyed double-ended diff performs the swap with bounded moves.
        expect(counts.insert).toBeLessThanOrEqual(4);
    });

    it('append one row to 1000 creates exactly one element', () => {
        const rows = makeRows(1000);
        renderer.render(rowList(rows) as any, container);
        ops.reset();

        renderer.render(rowList([...rows, ...makeRows(1, 1000)]) as any, container);

        const counts = ops.counts();
        expect(counts.createElement).toBe(1);
        expect(counts.createText).toBe(1);
        expect(counts.remove).toBe(0);
        expect(counts.setText).toBe(0);
    });

    it('remove one middle row of 1000 removes exactly one element', () => {
        const rows = makeRows(1000);
        renderer.render(rowList(rows) as any, container);
        ops.reset();

        const without = rows.filter(r => r.id !== 500);
        renderer.render(rowList(without) as any, container);

        const counts = ops.counts();
        // 2 = the <li> plus its text child (unmount removes per-vnode).
        expect(counts.remove).toBe(2);
        expect(counts.createElement).toBe(0);
        expect(counts.setText).toBe(0);
    });

    it('reverse 100 keyed rows reuses every element', () => {
        const rows = makeRows(100);
        renderer.render(rowList(rows) as any, container);
        ops.reset();

        renderer.render(rowList(rows.slice().reverse()) as any, container);

        const counts = ops.counts();
        expect(counts.createElement).toBe(0);
        expect(counts.remove).toBe(0);
    });
});

describe('component render counts (DOM)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('batched writes to 3 signals re-render a component exactly once', () => {
        const a = signal({ v: 0 });
        const b = signal({ v: 0 });
        const c = signal({ v: 0 });
        const renders = vi.fn();

        const Comp = component(() => () => {
            renders();
            return jsx('div', { children: `${a.v}-${b.v}-${c.v}` });
        });

        render(jsx(Comp, {}), container);
        expect(renders).toHaveBeenCalledTimes(1);

        batch(() => {
            a.v = 1;
            b.v = 2;
            c.v = 3;
        });
        expect(renders).toHaveBeenCalledTimes(2);
        expect(container.textContent).toBe('1-2-3');
    });

    it('signal read by parent and child re-renders the child exactly once per write', () => {
        const shared = signal({ v: 0 });
        const parentRenders = vi.fn();
        const childRenders = vi.fn();

        const Child = component<{ v: number }>((ctx) => () => {
            childRenders();
            return jsx('span', { children: `${shared.v}:${ctx.props.v}` });
        });

        const Parent = component(() => () => {
            parentRenders();
            return jsx('div', { children: jsx(Child, { v: shared.v }) });
        });

        render(jsx(Parent, {}), container);
        expect(parentRenders).toHaveBeenCalledTimes(1);
        expect(childRenders).toHaveBeenCalledTimes(1);

        shared.v = 1;
        expect(parentRenders).toHaveBeenCalledTimes(2);
        // Render queue dedup: own subscription + the parent's prop write
        // collapse into ONE child render per wave.
        expect(childRenders).toHaveBeenCalledTimes(2);
        expect(container.textContent).toBe('1:1');
    });

    it('parent-only update with static slot content does not re-render the child', () => {
        const parentOnly = signal({ v: 0 });
        const childRenders = vi.fn();

        const Child = component((ctx) => () => {
            childRenders();
            return jsx('div', { children: ctx.slots.default?.() });
        });

        const Parent = component(() => () =>
            jsx('div', {
                children: [
                    jsx('p', { children: String(parentOnly.v) }),
                    jsx(Child, { children: jsx('span', { children: 'static' }) }),
                ],
            })
        );

        render(jsx(Parent, {}), container);
        expect(childRenders).toHaveBeenCalledTimes(1);

        parentOnly.v = 1;
        // Identical slot content elides the version bump entirely.
        expect(childRenders).toHaveBeenCalledTimes(1);
        expect(container.textContent).toBe('1static');
    });

    it('slot content with a fresh inline handler still re-renders the child', () => {
        const parentOnly = signal({ v: 0 });
        const childRenders = vi.fn();

        const Child = component((ctx) => () => {
            childRenders();
            return jsx('div', { children: ctx.slots.default?.() });
        });

        const Parent = component(() => () =>
            jsx('div', {
                children: [
                    jsx('p', { children: String(parentOnly.v) }),
                    // fresh closure every parent render -> must NOT be elided
                    jsx(Child, { children: jsx('button', { onClick: () => parentOnly.v, children: 'go' }) }),
                ],
            })
        );

        render(jsx(Parent, {}), container);
        expect(childRenders).toHaveBeenCalledTimes(1);

        parentOnly.v = 1;
        expect(childRenders).toHaveBeenCalledTimes(2);
    });

    it('nested static slot trees are elided too', () => {
        const parentOnly = signal({ v: 0 });
        const childRenders = vi.fn();

        const Child = component((ctx) => () => {
            childRenders();
            return jsx('div', { children: ctx.slots.default?.() });
        });

        const Parent = component(() => () =>
            jsx('div', {
                children: [
                    jsx('p', { children: String(parentOnly.v) }),
                    jsx(Child, {
                        children: jsx('ul', {
                            children: [
                                jsx('li', { key: 1, class: 'a', children: 'one' }),
                                jsx('li', { key: 2, class: 'b', children: ['two', jsx('em', { children: '!' })] }),
                            ],
                        }),
                    }),
                ],
            })
        );

        render(jsx(Parent, {}), container);
        expect(childRenders).toHaveBeenCalledTimes(1);

        parentOnly.v = 1;
        parentOnly.v = 2;
        expect(childRenders).toHaveBeenCalledTimes(1);
        expect(container.textContent).toBe('2onetwo!');
    });

    it('inline event handlers re-bind without listener churn (stable invoker)', () => {
        const count = signal({ v: 0 });
        const clicks: number[] = [];

        const Comp = component(() => () =>
            jsx('button', {
                // fresh closure every render
                onClick: () => clicks.push(count.v),
                children: String(count.v),
            })
        );

        render(jsx(Comp, {}), container);
        const button = container.querySelector('button')!;
        const addSpy = vi.spyOn(button, 'addEventListener');
        const removeSpy = vi.spyOn(button, 'removeEventListener');

        count.v = 1;
        count.v = 2;
        count.v = 3;

        // Re-renders swap the invoker's inner value; the DOM listener is
        // attached exactly once (at mount, before the spy) and never removed.
        expect(addSpy).not.toHaveBeenCalled();
        expect(removeSpy).not.toHaveBeenCalled();

        // The swapped handler is the LATEST closure.
        button.dispatchEvent(new MouseEvent('click'));
        expect(clicks).toEqual([3]);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it('changed slot content re-renders the child exactly once', () => {
        const label = signal({ v: 'a' });
        const childRenders = vi.fn();

        const Child = component((ctx) => () => {
            childRenders();
            return jsx('div', { children: ctx.slots.default?.() });
        });

        const Parent = component(() => () =>
            jsx('div', {
                children: jsx(Child, { children: jsx('span', { children: label.v }) }),
            })
        );

        render(jsx(Parent, {}), container);
        expect(childRenders).toHaveBeenCalledTimes(1);

        label.v = 'b';
        expect(childRenders).toHaveBeenCalledTimes(2);
        expect(container.textContent).toBe('b');
    });
});
