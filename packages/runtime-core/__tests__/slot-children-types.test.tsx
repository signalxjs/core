/**
 * A slot fill is checked against the slot it fills (#536).
 *
 * Like `attrs-types.test.tsx`, this file earns its keep at `pnpm typecheck`:
 * every `@ts-expect-error` below fails the build if the mistake stops being
 * rejected — and an `@ts-expect-error` that stops being needed fails too, so
 * the positives are pinned just as hard as the negatives.
 *
 * Two halves, because a declaration is only useful if BOTH sides honour it:
 *
 * - the FILL side — `children` used to be `any`, so a
 *   `({ active }) => …` fill compiled against a slot that declares no scoped
 *   props at all. That is the shape `@sigx/lynx-navigation` shipped (#534).
 * - the CONSUMER side — `SlotsObject` used to intersect an untyped zero-arg
 *   `default?: () => JSXElement[]` with the declared slot, and
 *   `DefaultSlot & ((props: P) => …)` is callable both ways, so
 *   `slots.default?.()` compiled on a slot whose props were declared and the
 *   fill was handed nothing.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { component } from '../src';
import type { Define } from '../src';

/** A slot that declares scoped props. */
type ScopedProps = Define.Slot<'default', { active: boolean }>;
/** A slot that declares NO scoped props. */
type PlainProps = Define.Slot<'default'>;
/** A component that declares no slots at all. */
type NoSlotProps = Define.Prop<'label', string>;

const Scoped = component<ScopedProps>((ctx) => () => ctx.slots.default?.({ active: true }));
const Plain = component<PlainProps>((ctx) => () => ctx.slots.default?.());
const NoSlot = component<NoSlotProps>(() => () => null);

describe('a fill is checked against the slot it fills', () => {
    it('rejects a fill that expects props the slot does not declare', () => {
        // @ts-expect-error `default` declares no scoped props, so a fill cannot require any
        const el = <Plain>{({ active }: { active: boolean }) => <span>{String(active)}</span>}</Plain>;
        expect(el).toBeDefined();
    });

    it('rejects a fill whose parameter disagrees with the declared props', () => {
        // @ts-expect-error the slot declares `{ active: boolean }`, not `{ nope: string }`
        const el = <Scoped>{(p: { nope: string }) => <span>{p.nope}</span>}</Scoped>;
        expect(el).toBeDefined();
    });

    it('infers an unannotated fill parameter from the declaration', () => {
        const el = <Scoped>{(p) => {
            // The payoff: no annotation, no cast, and `p` is typed.
            expectTypeOf(p).toEqualTypeOf<{ active: boolean }>();
            return <span>{String(p.active)}</span>;
        }}</Scoped>;
        expect(el).toBeDefined();
    });

    it('still accepts a zero-parameter fill on a slot without scoped props', () => {
        const el = <Plain>{() => <span>hi</span>}</Plain>;
        expect(el).toBeDefined();
    });

    it('still accepts ordinary children of every shape', () => {
        const items = ['a', 'b'];
        const cond = false;
        const elements = <Plain><span>hi</span></Plain>;
        const text = <Plain>text</Plain>;
        const num = <Plain>{42}</Plain>;
        const list = <Plain>{items.map((i) => <span>{i}</span>)}</Plain>;
        const nullish = <Plain>{null}</Plain>;
        const undef = <Plain>{undefined}</Plain>;
        const conditional = <Plain>{cond && <span>maybe</span>}</Plain>;
        const mixed = <Plain><span>a</span>{items.map((i) => <b>{i}</b>)}{'tail'}</Plain>;

        expect([elements, text, num, list, nullish, undef, conditional, mixed]).toHaveLength(8);
    });

    it('mixes element children with a render-prop fill, as the runtime does', () => {
        const el = <Scoped><span>static</span>{(p) => <b>{String(p.active)}</b>}</Scoped>;
        expect(el).toBeDefined();
    });

    // The deliberate limit: with no declaration there is nothing to check
    // against, so children stay `any` and a stray function is accepted.
    // Declaring the slot is what buys the checking.
    it('leaves children unchecked on a component that declares no default slot', () => {
        const el = <NoSlot label="x">{({ whatever }: { whatever: number }) => <span>{whatever}</span>}</NoSlot>;
        expect(el).toBeDefined();
    });
});

describe('a declared slot is required to be called with its props', () => {
    it('rejects invoking a scoped slot with no props', () => {
        component<ScopedProps>((ctx) => {
            // @ts-expect-error `{ active: boolean }` is declared, so it must be passed
            const out = ctx.slots.default?.();
            return () => out;
        });
        expect(true).toBe(true);
    });

    it('accepts invoking a scoped slot with its props', () => {
        component<ScopedProps>((ctx) => () => ctx.slots.default?.({ active: true }));
        expect(true).toBe(true);
    });

    it('still allows a bare call on a slot without declared props', () => {
        component<PlainProps>((ctx) => () => ctx.slots.default?.());
        expect(true).toBe(true);
    });

    it('still allows a bare call on a component that declares no slots', () => {
        component<NoSlotProps>((ctx) => () => ctx.slots.default?.());
        expect(true).toBe(true);
    });
});

// Scoped props are all-or-nothing per slot: the documented way to express
// "these may be absent" is optional MEMBERS, not an optional argument.
describe('optional scoped props', () => {
    it('are expressed as optional members and called with an object', () => {
        type OptionalProps = Define.Slot<'default', { index?: number }>;
        const Optional = component<OptionalProps>((ctx) => () => ctx.slots.default?.({}));
        const el = <Optional>{(p) => <span>{p.index ?? 0}</span>}</Optional>;
        expect(el).toBeDefined();
    });
});

// A props type can be a union — a discriminated union of prop shapes is the
// ordinary way to write one — and `ExtractSlots` distributes, so `TSlots`
// arrives as a union too. `keyof (A | B)` is the INTERSECTION of their keys, so
// asking `'default' extends keyof TSlots` directly reads as false whenever any
// member lacks the slot, and the checking silently switches itself off.
describe('a union props type still gets its slot checked', () => {
    type UnionProps =
        | (Define.Prop<'kind', 'scoped'> & Define.Slot<'default', { active: boolean }>)
        | Define.Prop<'kind', 'bare'>;

    const Union = component<UnionProps>((ctx) => () => ctx.slots.default?.({ active: true }));

    it('checks a fill against the member that declares the slot', () => {
        // @ts-expect-error the declared slot props are `{ active: boolean }`
        const el = <Union kind="scoped">{(p: { nope: string }) => <span>{p.nope}</span>}</Union>;
        expect(el).toBeDefined();
    });

    it('still requires the props at the accessor', () => {
        component<UnionProps>((ctx) => {
            // @ts-expect-error `{ active: boolean }` is declared on a union member
            const out = ctx.slots.default?.();
            return () => out;
        });
        expect(true).toBe(true);
    });

    it('accepts a correct fill', () => {
        const el = <Union kind="scoped">{(p) => <span>{String(p.active)}</span>}</Union>;
        expect(el).toBeDefined();
    });
});
