import { bench, describe } from 'vitest';
import { createRenderer } from '../src/renderer';
import { jsx, Fragment } from '../src/jsx-runtime';
import { createCountingNodeOps, makeRows, type Row } from './helpers/perf-harness';

/**
 * Pure diff-cost benchmarks against the mock host (`pnpm bench`):
 * no real DOM, so this isolates vnode creation + reconciliation.
 * Compare relative before/after numbers on the same machine.
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

function setup(rows: Row[]) {
    const ops = createCountingNodeOps();
    const renderer = createRenderer(ops as any);
    const container = ops.createContainer();
    renderer.render(rowList(rows) as any, container);
    return { renderer, container };
}

describe('keyed list diffing (1000 rows, mock host)', () => {
    const rows = makeRows(1000);

    const swapped = rows.slice();
    [swapped[1], swapped[997]] = [swapped[997], swapped[1]];
    const swapEnv = setup(rows);
    let swapFlip = false;
    bench('swap rows 2 and 998', () => {
        swapFlip = !swapFlip;
        swapEnv.renderer.render(rowList(swapFlip ? swapped : rows) as any, swapEnv.container);
    });

    const reversed = rows.slice().reverse();
    const revEnv = setup(rows);
    let revFlip = false;
    bench('reverse all rows', () => {
        revFlip = !revFlip;
        revEnv.renderer.render(rowList(revFlip ? reversed : rows) as any, revEnv.container);
    });

    const updated = rows.map((r, i) => (i % 10 === 0 ? { ...r, label: `${r.label} !` } : r));
    const partialEnv = setup(rows);
    let partialFlip = false;
    bench('partial update every 10th row', () => {
        partialFlip = !partialFlip;
        partialEnv.renderer.render(rowList(partialFlip ? updated : rows) as any, partialEnv.container);
    });

    const selectEnv = setup(rows);
    let sel = 0;
    bench('select row (single class change)', () => {
        sel = (sel % 1000) + 1;
        selectEnv.renderer.render(rowList(rows, sel) as any, selectEnv.container);
    });

    const shuffled = rows.slice();
    // Deterministic pseudo-shuffle (no Math.random: keep runs comparable).
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (i * 7919 + 13) % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const shuffleEnv = setup(rows);
    let shuffleFlip = false;
    bench('pseudo-random shuffle (LIS tripwire)', () => {
        shuffleFlip = !shuffleFlip;
        shuffleEnv.renderer.render(rowList(shuffleFlip ? shuffled : rows) as any, shuffleEnv.container);
    });
});
