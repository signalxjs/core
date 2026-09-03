/**
 * `CombinedOf` / `PropsOf` / `RefOf` / `SlotsOf` take a `ComponentFactory`
 * apart through a public seam (#535).
 *
 * `@sigx/zero`'s `adapt` module re-parameterizes factories from outside —
 * `ComponentFactory<Omit<F['__events'], X> & Y, F['__ref'], F['__slots']>` —
 * and that worked only because the `@internal` brands are structurally
 * visible, so a downstream package was load-bearing on names that read as
 * private. These aliases are the supported reads; the brands may be renamed
 * behind them. Like `slot-children-types.test.tsx`, this file earns its keep
 * at `pnpm typecheck`.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { component } from '../src';
import type {
    AnyComponentFactory,
    ComponentFactory,
    Define,
    Exposed,
    CombinedOf,
    PropsOf,
    RefOf,
    SlotsOf,
} from '../src';

// A factory declaring all four things the brands carry.
type Api = { reset(): void; count(): number };
type Props =
    & Define.Prop<'label', string, true>
    & Define.Prop<'disabled', boolean>
    & Define.Event<'select', { id: number }>
    & Define.Slot<'default'>
    & Define.Slot<'item', { index: number }>
    & Define.Expose<Api>;

const Widget = component<Props>((ctx) => {
    ctx.expose({ reset() {}, count: () => 0 });
    return () => ctx.slots.default?.();
});

/** The shape zero builds: swap one event for another, keep ref + slots. */
type Adapted<F extends AnyComponentFactory, TRemove extends string, TAdd> =
    ComponentFactory<Omit<CombinedOf<F>, TRemove> & TAdd, RefOf<F>, SlotsOf<F>>;

describe('factory aliases (#535)', () => {
    it('read the four brands of a factory built by component<T>()', () => {
        // CombinedOf is the declaration as given — events, slots, expose
        // markers and all — so it can be re-parameterized losslessly.
        expectTypeOf<CombinedOf<typeof Widget>>().toEqualTypeOf<Props>();
        // PropsOf is the stripped view setup is typed with: the slot and
        // expose markers are gone (event keys are ordinary props to it).
        expectTypeOf<PropsOf<typeof Widget>>().toHaveProperty('label');
        expectTypeOf<PropsOf<typeof Widget>>().not.toHaveProperty('__exposed');
        expectTypeOf<PropsOf<typeof Widget>>().not.toHaveProperty('__slots');
        expectTypeOf<PropsOf<typeof Widget>['label']>().toEqualTypeOf<string>();
        // RefOf is what `expose()` publishes — the same read as `Exposed`.
        expectTypeOf<RefOf<typeof Widget>>().toEqualTypeOf<Api>();
        expectTypeOf<RefOf<typeof Widget>>().toEqualTypeOf<Exposed<typeof Widget>>();
        // SlotsOf is the slot table `Define.Slot` produced.
        expectTypeOf<SlotsOf<typeof Widget>>().toHaveProperty('item');
        expectTypeOf<NonNullable<SlotsOf<typeof Widget>['item']>>()
            .parameter(0)
            .toEqualTypeOf<{ index: number }>();
        expect(Widget).toBeTypeOf('function');
    });

    it('round-trip an explicitly parameterized ComponentFactory exactly', () => {
        type Combined = Define.Prop<'value', number> & Define.Event<'change', number>;
        type Slots = { default?: () => null };
        type F = ComponentFactory<Combined, Api, Slots>;

        expectTypeOf<CombinedOf<F>>().toEqualTypeOf<Combined>();
        expectTypeOf<RefOf<F>>().toEqualTypeOf<Api>();
        expectTypeOf<SlotsOf<F>>().toEqualTypeOf<Slots>();
        // Rebuilding from the three reads gives back the same factory type.
        expectTypeOf<ComponentFactory<CombinedOf<F>, RefOf<F>, SlotsOf<F>>>().toEqualTypeOf<F>();
    });

    it('re-parameterize a factory the way an adapter does', () => {
        type Swapped = Adapted<typeof Widget, 'select', Define.Event<'pick', { id: number }>>;

        // The removed event is gone, the added one is there; ref and slots
        // came through untouched.
        expectTypeOf<CombinedOf<Swapped>>().not.toHaveProperty('select');
        expectTypeOf<CombinedOf<Swapped>>().toHaveProperty('pick');
        expectTypeOf<RefOf<Swapped>>().toEqualTypeOf<Api>();
        expectTypeOf<SlotsOf<Swapped>>().toEqualTypeOf<SlotsOf<typeof Widget>>();

        // And the JSX surface follows: the new handler is accepted, the old
        // one rejected, the ref still typed.
        const Swapped = Widget as unknown as Swapped;
        const ok = <Swapped label="x" onPick={(d) => { expectTypeOf(d).toEqualTypeOf<{ id: number }>(); }} />;
        // @ts-expect-error `select` was adapted away
        const gone = <Swapped label="x" onSelect={() => {}} />;
        expect([ok, gone]).toHaveLength(2);
    });

    it('only accept a factory', () => {
        // @ts-expect-error a plain object is not a ComponentFactory
        type _Bad = CombinedOf<{ __events: {} }>;
        expect(true).toBe(true);
    });
});
