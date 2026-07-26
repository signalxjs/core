/**
 * `mergeProps` (#525).
 *
 * A JSX spread is lowered by the compiler into one object literal before the
 * runtime sees it, so `<button {...rest} {...bag} />` lets later keys clobber
 * earlier ones. These tests pin the four kinds of key that combine instead,
 * and — just as importantly — that everything else still behaves exactly like
 * a spread.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, patchProp } from '@sigx/runtime-dom';
import { component, jsx, mergeProps } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('mergeProps', () => {
    describe('ordinary keys follow spread semantics', () => {
        it('last source wins', () => {
            const merged = mergeProps({ a: 1, b: 2 }, { b: 3, c: 4 });
            expect({ ...merged }).toEqual({ a: 1, b: 3, c: 4 });
        });

        it('an explicit undefined still wins — this is a spread, not a defaults helper', () => {
            const merged = mergeProps({ a: 1 }, { a: undefined });
            expect(merged.a).toBeUndefined();
            expect('a' in merged).toBe(true);
            expect(Object.keys(merged)).toEqual(['a']);
        });

        it('skips nullish sources', () => {
            const merged = mergeProps(null, { a: 1 }, undefined);
            expect({ ...merged }).toEqual({ a: 1 });
        });

        it('accepts thunks and re-reads them on every access', () => {
            let n = 1;
            const merged = mergeProps(() => ({ n }));
            expect(merged.n).toBe(1);
            n = 2;
            expect(merged.n).toBe(2);
        });

        it('copies own enumerable keys only, like a spread — not inherited ones', () => {
            const base = { inherited: 'nope' };
            const source = Object.create(base) as Record<string, unknown>;
            source.own = 'yes';

            // `{ ...source }` would be `{ own: 'yes' }`, so this must be too.
            expect({ ...source }).toEqual({ own: 'yes' });
            expect({ ...mergeProps(source) }).toEqual({ own: 'yes' });
            expect('inherited' in mergeProps(source)).toBe(false);
        });

        it('supports has / ownKeys / destructuring', () => {
            const merged = mergeProps({ a: 1 }, { b: 2 });
            expect('a' in merged).toBe(true);
            expect('zz' in merged).toBe(false);
            expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
            const { a, missing = 'default' } = merged as Record<string, any>;
            expect(a).toBe(1);
            expect(missing).toBe('default');
        });
    });

    describe('class', () => {
        it('concatenates in argument order', () => {
            const merged = mergeProps({ class: 'consumer' }, { class: 'zero' });
            expect(merged.class).toBe('consumer zero');
        });

        it('unifies class and className into one slot, emitted as class', () => {
            const merged = mergeProps({ className: 'a' }, { class: 'b' });
            expect(merged.class).toBe('a b');
            expect(Object.keys(merged)).toEqual(['class']);
        });

        it('drops empty values rather than emitting stray spaces', () => {
            const merged = mergeProps({ class: '' }, { class: 'b' }, { class: undefined });
            expect(merged.class).toBe('b');
        });

        it('is absent when no source sets it', () => {
            const merged = mergeProps({ a: 1 });
            expect('class' in merged).toBe(false);
        });
    });

    describe('style', () => {
        it('merges two objects left to right', () => {
            const merged = mergeProps(
                { style: { color: 'red', margin: '1px' } },
                { style: { color: 'blue' } }
            );
            expect(merged.style).toEqual({ color: 'blue', margin: '1px' });
        });

        it('parses a string source before merging', () => {
            const merged = mergeProps({ style: 'color: red; margin: 1px' }, { style: { color: 'blue' } });
            expect(merged.style).toEqual({ color: 'blue', margin: '1px' });
        });

        it('merges two strings', () => {
            const merged = mergeProps({ style: 'color: red' }, { style: 'margin: 1px' });
            expect(merged.style).toEqual({ color: 'red', margin: '1px' });
        });

        it('keeps the parser edge cases — parens are atomic', () => {
            const merged = mergeProps({ style: 'background: linear-gradient(45deg, red, blue)' });
            expect(merged.style).toEqual({ background: 'linear-gradient(45deg, red, blue)' });
        });

        it('ignores a style value that is neither a string nor an object', () => {
            // `Object.assign` skips null/undefined sources rather than
            // throwing, so an unusable style part contributes nothing and the
            // read stays safe.
            expect(() => ({ ...mergeProps({ style: 1 as any }) })).not.toThrow();
            expect(mergeProps({ style: 1 as any }).style).toEqual({});
            expect(mergeProps({ style: 1 as any }, { style: { color: 'red' } }).style)
                .toEqual({ color: 'red' });
        });
    });

    describe('handlers', () => {
        it('chains in source order', () => {
            const calls: string[] = [];
            const merged = mergeProps(
                { onClick: () => calls.push('consumer') },
                { onClick: () => calls.push('component') }
            );
            merged.onClick('event');
            expect(calls).toEqual(['consumer', 'component']);
        });

        it('passes every argument through', () => {
            const seen: unknown[][] = [];
            const merged = mergeProps({ onClick: (...args: unknown[]) => seen.push(args) });
            merged.onClick(1, 2);
            expect(seen).toEqual([[1, 2]]);
        });

        it('collapses two spellings of one event into a single key', () => {
            const calls: string[] = [];
            const merged = mergeProps(
                { onClick: () => calls.push('camel') },
                { onclick: () => calls.push('lower') }
            );

            // One key out — the first spelling seen owns it — so two handlers
            // can never reach the same invoker slot in patchProp.
            expect(Object.keys(merged)).toEqual(['onClick']);
            expect('onclick' in merged).toBe(false);

            merged.onClick('event');
            expect(calls).toEqual(['camel', 'lower']);
        });

        it('leaves a single handler identity alone', () => {
            const fn = () => { };
            const merged = mergeProps({ onClick: fn });
            expect(merged.onClick).toBe(fn);
        });

        it('does not touch a namespaced handler like onUpdate:modelValue', () => {
            const first = () => { };
            const second = () => { };
            const merged = mergeProps({ 'onUpdate:modelValue': first }, { 'onUpdate:modelValue': second });
            // Last wins, unchained, un-renormalized — it carries stamped
            // handler state and has its own patchProp branch.
            expect(merged['onUpdate:modelValue']).toBe(second);
        });

        it('does not chain a non-function on* value', () => {
            const merged = mergeProps({ onClick: 'nope' }, { onClick: 'later' });
            expect(merged.onClick).toBe('later');
        });

        // A handler-shaped key must land in exactly one bucket. When a
        // function and a non-function arrived for the same event, it used to
        // land in both the handler group AND the plain map, so `ownKeys`
        // returned it twice and any spread threw
        // "TypeError: 'ownKeys' on proxy: trap returned duplicate entries".
        it('emits one key when a handler and a non-handler share an event', () => {
            const fnFirst = mergeProps({ onClick: () => { } }, { onClick: undefined });
            expect(Object.keys(fnFirst)).toEqual(['onClick']);
            expect(() => ({ ...fnFirst })).not.toThrow();

            const fnLast = mergeProps({ onClick: 'x' }, { onClick: () => { } });
            expect(Object.keys(fnLast)).toEqual(['onClick']);
            expect(() => ({ ...fnLast })).not.toThrow();
        });

        it('lets a non-function overwrite the handlers before it, as a spread would', () => {
            const merged = mergeProps({ onClick: () => { } }, { onClick: undefined });
            expect(merged.onClick).toBeUndefined();
        });

        it('resumes chaining after a reset, across spellings', () => {
            const calls: string[] = [];
            const merged = mergeProps(
                { onClick: () => calls.push('before') },
                { onclick: null },
                { onClick: () => calls.push('after-1') },
                { onclick: () => calls.push('after-2') }
            );

            expect(Object.keys(merged)).toEqual(['onClick']);
            merged.onClick();
            expect(calls).toEqual(['after-1', 'after-2']);
        });

        it('leaves a data prop that merely starts with "on" alone', () => {
            // No source gives these events a function, so no group forms and
            // they stay ordinary last-wins keys.
            const merged = mergeProps({ once: true }, { onceMore: 'x' });
            expect({ ...merged }).toEqual({ once: true, onceMore: 'x' });
        });
    });

    describe('ref', () => {
        it('feeds every source ref, in both forms', () => {
            const fnSeen: unknown[] = [];
            const objRef: { current: unknown } = { current: null };
            const merged = mergeProps(
                { ref: (v: unknown) => fnSeen.push(v) },
                { ref: objRef }
            );

            merged.ref('element');
            expect(fnSeen).toEqual(['element']);
            expect(objRef.current).toBe('element');
        });

        it('passes a single ref through unchanged', () => {
            const ref = () => { };
            expect(mergeProps({ ref }).ref).toBe(ref);
        });
    });

    describe('derived values keep a stable identity', () => {
        it('returns the same chained handler while its contributors are unchanged', () => {
            const a = () => { };
            const b = () => { };
            const merged = mergeProps({ onClick: a }, { onClick: b });
            expect(merged.onClick).toBe(merged.onClick);
        });

        it('returns the same chained ref while its contributors are unchanged', () => {
            const merged = mergeProps({ ref: () => { } }, { ref: () => { } });
            expect(merged.ref).toBe(merged.ref);
        });

        it('rebuilds when a contributor changes identity', () => {
            let handler = () => { };
            const merged = mergeProps(() => ({ onClick: handler }), { onClick: () => { } });
            const first = merged.onClick;
            handler = () => { };
            expect(merged.onClick).not.toBe(first);
        });
    });

    describe('end to end, on a real element', () => {
        let container: HTMLElement;

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
        });

        afterEach(() => {
            container.remove();
        });

        it('forwards the consumer\'s attributes and composes with the component\'s own', () => {
            const consumerClicks: string[] = [];
            const ownClicks: string[] = [];

            const Button = component<Record<string, any>>(ctx => {
                const merged = mergeProps(
                    () => {
                        const { variant: _variant, ...rest } = ctx.props;
                        return rest;
                    },
                    () => ({
                        class: 'btn',
                        'data-part': 'root',
                        onClick: () => ownClicks.push('own')
                    })
                );
                return () => jsx('button', { ...merged });
            });

            render(jsx(Button, {
                variant: 'primary',
                class: 'consumer',
                id: 'save',
                'data-testid': 't',
                onClick: () => consumerClicks.push('consumer')
            }), container);

            const el = container.querySelector('button')!;
            expect(el.getAttribute('class')).toBe('consumer btn');
            expect(el.getAttribute('id')).toBe('save');
            expect(el.getAttribute('data-testid')).toBe('t');
            expect(el.getAttribute('data-part')).toBe('root');
            expect(el.hasAttribute('variant')).toBe(false);

            el.click();
            expect(consumerClicks).toEqual(['consumer']);
            expect(ownClicks).toEqual(['own']);
        });

        it('installs exactly one DOM listener for two spellings', () => {
            const merged = mergeProps({ onClick: () => { } }, { onclick: () => { } });
            const el = document.createElement('button');
            container.appendChild(el);

            for (const key of Object.keys(merged)) {
                patchProp(el, key, null, merged[key]);
            }

            const handlers = (el as any).__sigx_event_handlers as Map<string, unknown>;
            expect(handlers.size).toBe(1);
        });

        it('stays reactive — a thunk source re-reads on re-render', () => {
            const state = signal({ label: 'a' });

            const Comp = component<Record<string, any>>(ctx => {
                const merged = mergeProps(() => ctx.props, () => ({ title: state.label }));
                return () => jsx('div', { ...merged });
            });

            render(jsx(Comp, { id: 'x' }), container);
            const el = container.querySelector('div')!;
            expect(el.getAttribute('title')).toBe('a');

            state.label = 'b';
            expect(el.getAttribute('title')).toBe('b');
        });

        it('does not warn about colliding spellings — that is the point', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const merged = mergeProps({ onClick: () => { } }, { onclick: () => { } });
            render(jsx('button', { ...merged }), container);
            expect(warn).not.toHaveBeenCalled();
            warn.mockRestore();
        });
    });
});
