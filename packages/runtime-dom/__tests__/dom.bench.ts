import { bench, describe } from 'vitest';
import { render } from '../src/index';
import { component, jsx, Fragment } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { makeRows, type Row } from '../../runtime-core/__tests__/helpers/perf-harness';

/**
 * Standard row-list update scenarios on happy-dom (`pnpm bench`):
 * create/replace/partial-update/select/swap/clear/prepend.
 *
 * happy-dom has no layout/paint, so absolute numbers say nothing about
 * browser performance — these measure framework overhead only (vnode
 * creation, diffing, DOM-op volume), which is exactly what the #59 work
 * targets. Compare relative before/after numbers on the same machine.
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

function mounted(rows: Row[]) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(rowList(rows), container);
    return container;
}

describe('list scenarios (happy-dom)', () => {
    const rows1k = makeRows(1000);

    bench('create 1,000 rows', () => {
        const container = document.createElement('div');
        render(rowList(makeRows(1000)), container);
    });

    bench('create 10,000 rows', () => {
        const container = document.createElement('div');
        render(rowList(makeRows(10_000)), container);
    });

    const replaceTarget = mounted(rows1k);
    let replaceGen = 0;
    bench('replace all 1,000 rows', () => {
        replaceGen += 1000;
        render(rowList(makeRows(1000, replaceGen)), replaceTarget);
    });

    const updated = rows1k.map((r, i) => (i % 10 === 0 ? { ...r, label: `${r.label} !` } : r));
    const partialTarget = mounted(rows1k);
    let partialFlip = false;
    bench('partial update every 10th row', () => {
        partialFlip = !partialFlip;
        render(rowList(partialFlip ? updated : rows1k), partialTarget);
    });

    const selectTarget = mounted(rows1k);
    let sel = 0;
    bench('select row', () => {
        sel = (sel % 1000) + 1;
        render(rowList(rows1k, sel), selectTarget);
    });

    const swapped = rows1k.slice();
    [swapped[1], swapped[997]] = [swapped[997], swapped[1]];
    const swapTarget = mounted(rows1k);
    let swapFlip = false;
    bench('swap rows 2 and 998', () => {
        swapFlip = !swapFlip;
        render(rowList(swapFlip ? swapped : rows1k), swapTarget);
    });

    const clearTarget = mounted(rows1k);
    let clearFlip = false;
    bench('clear 1,000 rows / remount', () => {
        clearFlip = !clearFlip;
        render(rowList(clearFlip ? [] : rows1k), clearTarget);
    });

    const prepended = [...makeRows(100, 100_000), ...rows1k];
    const prependTarget = mounted(rows1k);
    let prependFlip = false;
    bench('prepend 100 rows to 1,000', () => {
        prependFlip = !prependFlip;
        render(rowList(prependFlip ? prepended : rows1k), prependTarget);
    });
});

describe('component tree scenarios (happy-dom)', () => {
    // 50 child components all reading one shared signal through props AND
    // directly — measures redundant child re-renders (stages 5/6 target).
    const shared = signal({ v: 0 });

    const Leaf = component<{ v: number }>((ctx) => () =>
        jsx('span', { children: `${shared.v}:${ctx.props.v}` })
    );

    const Tree = component(() => () =>
        jsx('div', {
            children: Array.from({ length: 50 }, (_, i) =>
                jsx(Leaf, { key: i, v: shared.v + i })
            ),
        })
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(jsx(Tree, {}), container);

    let n = 0;
    bench('shared-signal write through 50 child components', () => {
        shared.v = ++n;
    });

    const staticSlotSignal = signal({ v: 0 });
    const Card = component((ctx) => () =>
        jsx('div', { children: ctx.slots.default() })
    );
    const SlotTree = component(() => () =>
        jsx('div', {
            children: [
                jsx('p', { children: String(staticSlotSignal.v) }),
                ...Array.from({ length: 50 }, (_, i) =>
                    jsx(Card, { key: i, children: jsx('span', { children: 'static' }) })
                ),
            ],
        })
    );

    const slotContainer = document.createElement('div');
    document.body.appendChild(slotContainer);
    render(jsx(SlotTree, {}), slotContainer);

    let sn = 0;
    bench('parent-only write above 50 static-slot children', () => {
        staticSlotSignal.v = ++sn;
    });
});
