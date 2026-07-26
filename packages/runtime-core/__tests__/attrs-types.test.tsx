/**
 * Host attributes on a component are an opt-in (#525).
 *
 * This file earns its keep at `pnpm typecheck`, not at runtime: every
 * `@ts-expect-error` below fails the build if the attribute stops being
 * rejected. `packages/*&#47;__tests__` is inside the root tsconfig program, so
 * these are checked on every run.
 *
 * The rule: a component accepts `id`, `class`, `style` and DOM handlers only
 * if it declares `& Define.Attrs`. Before #525 the first three were declared
 * on `JSX.IntrinsicAttributes`, which TypeScript adds to *every* JSX element
 * type — so they compiled on components that dropped them silently.
 *
 * `data-*` and `aria-*` are the exception, and it is not ours to fix — see
 * the second test.
 */

import { describe, it, expect } from 'vitest';
import { component } from '../src';
import type { Define } from '../src';

// A component that does NOT opt in.
const Bare = component<Define.Prop<'variant', 'a' | 'b'>>(() => () => null);

// The same component, opted in.
type OpenProps = Define.Prop<'variant', 'a' | 'b'> & Define.Attrs;
const Open = component<OpenProps>(() => () => null);

// A component whose own `title` prop shadows the host attribute.
type ShadowProps = Define.WithAttrs<Define.Prop<'title', { text: string }, true>>;
const Shadow = component<ShadowProps>(() => () => null);

describe('host attributes are opt-in', () => {
    it('rejects host attributes on a component that has not opted in', () => {
        // @ts-expect-error `class` is not declared and Bare forwards nothing
        const _class = <Bare variant="a" class="x" />;
        // @ts-expect-error `id` likewise
        const _id = <Bare variant="a" id="save" />;
        // @ts-expect-error handlers were never declared anywhere
        const _handler = <Bare variant="a" onMouseEnter={() => { }} />;

        expect([_class, _id, _handler].length).toBe(3);
    });

    // The honest limit of the opt-in, pinned so nobody assumes otherwise:
    // TypeScript exempts JSX attribute names that are not valid identifiers
    // from excess-property checking (`isKnownProperty`), so a hyphenated
    // attribute compiles on ANY component whatever its props type says. No
    // declaration can make these an error — which means the original symptom
    // (`<Button.Root data-density="compact">` compiling and going nowhere)
    // was never catchable by types. Forwarding at runtime is the only fix.
    it('cannot reject data-* / aria-* even on a component that has not opted in', () => {
        const _data = <Bare variant="a" data-density="compact" />;
        const _aria = <Bare variant="a" aria-label="Save" />;

        expect([_data, _aria].length).toBe(2);
    });

    it('accepts them once the component declares Define.Attrs', () => {
        const el = (
            <Open
                variant="a"
                class="x"
                id="save"
                style={{ color: 'red' }}
                title="tip"
                role="button"
                tabIndex={0}
                hidden={false}
                data-density="compact"
                aria-label="Save"
                onMouseEnter={() => { }}
                onKeyDown={(e) => { void e.key; }}
            />
        );
        expect(el).toBeDefined();
    });

    it('still rejects a typo — the opt-in must not become a free-for-all', () => {
        // @ts-expect-error no index signature, so unknown names still fail
        const _typo = <Open variant="a" onMouseEnterr={() => { }} />;
        // @ts-expect-error including on the component's own props
        const _propTypo = <Open varient="a" />;
        // @ts-expect-error per-tag attributes are deliberately NOT in the set
        const _perTag = <Open variant="a" placeholder="…" />;

        expect([_typo, _propTypo, _perTag].length).toBe(3);
    });

    it('lets a component shadow a host attribute with its own prop', () => {
        const el = <Shadow title={{ text: 'Delete?' }} class="x" />;
        expect(el).toBeDefined();

        // @ts-expect-error the component's declaration wins — a string is the
        // host attribute's type, not this component's
        const _wrong = <Shadow title="Delete?" />;
        expect(_wrong).toBeDefined();
    });

    it('accepts the same attribute spellings an intrinsic element does', () => {
        // ComponentAttributes mirrors HTMLAttributes' names and types on
        // purpose. If they drift, `<Open autoFocus>` fails while
        // `<button autoFocus>` compiles, which is indefensible.
        const opted = (
            <Open
                variant="a"
                autoFocus
                spellCheck="false"
                contentEditable="true"
                enterKeyHint="send"
                inputMode="numeric"
                translate="no"
                hidden="until-found"
                popover="auto"
            />
        );
        const intrinsic = (
            <button
                autoFocus
                spellCheck="false"
                contentEditable="true"
                enterKeyHint="send"
                inputMode="numeric"
                translate="no"
                hidden="until-found"
                popover="auto"
            />
        );
        expect([opted, intrinsic].length).toBe(2);
    });

    it('keeps intrinsic elements untouched', () => {
        // HTMLAttributes declares these directly, so narrowing
        // IntrinsicAttributes to `key` alone cannot reach them.
        const el = <div class="x" id="y" style={{ color: 'red' }} data-a="1" aria-label="z" />;
        expect(el).toBeDefined();
    });

    it('does not disturb declared events or models', () => {
        type EventProps =
            & Define.Prop<'label', string>
            & Define.Event<'select', string>
            & Define.Attrs;
        const WithEvent = component<EventProps>(() => () => null);

        // The declared event still infers its detail type…
        const el = <WithEvent label="x" onSelect={(v) => { void v.toUpperCase(); }} class="c" />;
        expect(el).toBeDefined();
    });
});
