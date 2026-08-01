/**
 * The slot accessor — `createSlots(children).default(...)`, the call every
 * component with children makes on every render.
 *
 * Why this suite exists: #480 taught the accessor to invoke a *function* child
 * as a render prop, and implemented it as a hand loop over the children with a
 * `typeof` test per item — replacing the `list.slice()` that every slot read
 * used to be. That is the right work for the rare list holding a function and
 * pure overhead for every other slot read in every app, and it shipped
 * unmeasured (#534): roughly 2x `slice` at a handful of children, ~6.5x at a
 * hundred. The accessor now records whether a function is present while it
 * collects the children and only walks when one is, so the ordinary case is a
 * copy again.
 *
 * The floor is therefore `list.slice()` itself — the irreducible work a slot
 * read must do to honour its defensive-copy contract. `ratioToFloor` is the
 * figure that survives a change of machine, and the figure that would move if
 * the per-read scan ever came back.
 *
 * Only the n=100 reads declare that floor. A slot read also pays a fixed cost
 * the floor does not model — the proxy trap, the presence check, the version
 * signal read — which is tens of nanoseconds, so at a handful of children that
 * fixed cost, not the copy, is what a ratio would measure (n=3 came out at
 * ~13x floor while n=100 sat at ~3.8x, the ratio falling as the copy grew).
 * At a hundred children the copy dominates and the ratio tracks the walk: it
 * would roughly triple if the per-read scan returned. The small-n reads are
 * reported as absolute timings instead.
 *
 * Each guard proves the accessor did the work: a bench measuring an accessor
 * that returned `[]`, or a render-prop fill that never ran, would report a
 * spectacular number forever.
 */
import { createSlots } from 'sigx/internals';
import { assert, type MicroBench, type MicroSuite } from './types.ts';

const el = (type: string): unknown => ({ type, props: {}, key: null, children: [], dom: null });

const elements = (n: number): unknown[] => Array.from({ length: n }, (_, i) => el(`c${i}`));

const namedElements = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({
        type: `c${i}`,
        props: { slot: 'side' },
        key: null,
        children: [],
        dom: null
    }));

/** The floor: the copy a slot read cannot avoid. */
function sliceFloor(n: number): MicroBench {
    const list = elements(n);
    return {
        suite: 'slots',
        name: `slice floor n=${n}`,
        isFloor: true,
        check: () => {
            assert(list.slice().length === n, `floor list is not ${n} long`);
        },
        run: () => list.slice()
    };
}

/**
 * A default slot of plain element children — the path every app takes.
 * `floor` only where the copy dominates the accessor's fixed cost (see header).
 */
function defaultSlot(n: number, quick = false, floor = false): MicroBench {
    const slots = createSlots(elements(n));
    return {
        suite: 'slots',
        name: `default slot, ${n} element children`,
        ...(floor ? { floorOf: `slice floor n=${n}` } : {}),
        quick,
        // Around a hundred nanoseconds — an order of magnitude below the two
        // SSR string benches #477 had to un-gate for the same reason. See the
        // header: the floor ratio is the figure that means something here.
        informational: true,
        check: () => {
            const out = slots.default!();
            assert(out.length === n, `default slot returned ${out.length} children, expected ${n}`);
            // The defensive-copy contract the floor is measured against.
            assert(out !== slots.default!(), 'default slot handed out the same array twice');
        },
        run: () => slots.default!()
    };
}

function namedSlot(n: number): MicroBench {
    const slots = createSlots(namedElements(n)) as unknown as Record<string, () => unknown[]>;
    return {
        suite: 'slots',
        name: `named slot, ${n} element children`,
        floorOf: `slice floor n=${n}`,
        check: () => {
            const out = slots.side!();
            assert(out.length === n, `named slot returned ${out.length} children, expected ${n}`);
        },
        run: () => slots.side!()
    };
}

/** The #476 feature path: a render-prop child, invoked with scoped props. */
function renderPropSlot(quick = false): MicroBench {
    const slots = createSlots([(p: { greeting: string }) => el(p.greeting)]);
    return {
        suite: 'slots',
        name: 'default slot, render-prop child',
        quick,
        // Sub-microsecond, like every bench in this suite — informational.
        informational: true,
        check: () => {
            const out = slots.default!({ greeting: 'hi' }) as { type: string }[];
            assert(out.length === 1, `render-prop slot returned ${out.length} children, expected 1`);
            assert(out[0].type === 'hi', 'the fill did not receive the scoped props — it never ran as a render prop');
        },
        run: () => slots.default!({ greeting: 'hi' })
    };
}

/**
 * The #534 path: a destructuring fill, accessor invoked with NO scoped props.
 * The guard is the regression test — on a build that hands the fill
 * `undefined` this throws before a number is ever reported.
 */
function noScopedPropsSlot(): MicroBench {
    const slots = createSlots([({ greeting }: { greeting?: string }) => el(String(greeting))]);
    return {
        suite: 'slots',
        name: 'default slot, render-prop child, no scoped props',
        check: () => {
            const out = slots.default!() as { type: string }[];
            assert(out.length === 1, `returned ${out.length} children, expected 1`);
            assert(
                out[0].type === 'undefined',
                'the fill did not receive an empty object — a destructuring fill would throw here'
            );
        },
        run: () => slots.default!()
    };
}

export const slotsSuite: MicroSuite = {
    name: 'slots',
    benches(): MicroBench[] {
        // Floors first — `run-micro` resolves `floorOf` against benches already
        // measured in this suite.
        return [
            defaultSlot(3, true),
            sliceFloor(100),
            defaultSlot(100, true, true),
            namedSlot(100),
            renderPropSlot(true),
            noScopedPropsSlot()
        ];
    }
};
