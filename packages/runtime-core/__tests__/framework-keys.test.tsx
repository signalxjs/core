/**
 * Framework keys must never reach the DOM (#523).
 *
 * Forwarding a component's leftover props onto its root element is the
 * intended pattern — `const { own, ...rest } = ctx.props; <button {...rest} />`.
 * That is only safe if framework-internal keys cannot ride along, which this
 * pins from both directions: `key`/`ref` are peeled before setup ever sees
 * them, and `client:*` / `Model`-valued props are skipped where they would
 * otherwise be written to an element.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx, createModel, lazy } from '@sigx/runtime-core';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('framework keys never reach the DOM', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    describe('peeled before setup — key and ref', () => {
        it('does not expose key or ref on ctx.props', () => {
            let seen: string[] = [];
            const Comp = component<Record<string, any>>(ctx => {
                seen = Object.keys(ctx.props).filter(k => k !== 'children');
                return () => jsx('div', {});
            });

            render(jsx(Comp, { key: 'k1', ref: () => { }, real: 1 }), container);
            expect(seen).toEqual(['real']);
        });

        it('a rest spread cannot put key or ref on the element', () => {
            const Comp = component<Record<string, any>>(ctx => () => {
                const { own: _own, ...rest } = ctx.props;
                return jsx('button', { ...rest });
            });

            render(jsx(Comp, { own: 'x', key: 'k1', ref: () => { }, id: 'save' }), container);

            const el = container.querySelector('button')!;
            expect(el.getAttribute('id')).toBe('save');
            expect(el.hasAttribute('key')).toBe(false);
            expect(el.hasAttribute('ref')).toBe(false);
            expect(el.hasAttribute('own')).toBe(false);
        });

        it('a spread onto a child component carries no key', () => {
            let childKeys: string[] = [];
            const Child = component<Record<string, any>>(ctx => {
                childKeys = Object.keys(ctx.props).filter(k => k !== 'children');
                return () => jsx('span', {});
            });

            // `jsx()` reads `props.key` as the vnode key, so forwarding it
            // sets a key on the child that the author never wrote. Harmless
            // when it matches the wrapper's own key, but it is a vnode-level
            // concern leaking into data, and it decides sibling identity.
            const Wrapper = component<Record<string, any>>(ctx =>
                () => jsx(Child, { ...ctx.props }));

            render(jsx(Wrapper, { key: 'a', n: 1 }), container);
            expect(childKeys).toEqual(['n']);
        });

        it("calls the consumer's ref exactly once, with the exposed value", () => {
            const refCalls: unknown[] = [];
            const Comp = component<Record<string, any>>(ctx => {
                ctx.expose({ api: true });
                return () => {
                    const { own: _own, ...rest } = ctx.props;
                    return jsx('button', { ...rest });
                };
            });

            render(jsx(Comp, { own: 'x', ref: (v: unknown) => refCalls.push(v) }), container);

            // Without the peel the spread would bind it a second time, now to
            // the <button>, and clobber the exposed value.
            expect(refCalls).toEqual([{ api: true }]);
        });

        it('still forwards ref through lazy() to the inner component', async () => {
            const Inner = component<Record<string, any>>(ctx => {
                ctx.expose({ inner: true });
                return () => jsx('div', { class: 'inner' });
            }, { name: 'Inner' });

            let resolveLazy!: (mod: { default: typeof Inner }) => void;
            const LazyInner = lazy(() =>
                new Promise<{ default: typeof Inner }>(r => { resolveLazy = r; }));

            const refCalls: unknown[] = [];
            render(jsx(LazyInner, { ref: (v: unknown) => refCalls.push(v) }), container);

            resolveLazy({ default: Inner });
            await tick();
            await tick();

            expect(container.querySelector('.inner')).toBeTruthy();
            expect(refCalls).toContainEqual({ inner: true });
        });
    });

    describe('skipped at the element — client:* and Model values', () => {
        it('does not render a client:* directive as an attribute', () => {
            const Comp = component<Record<string, any>>(ctx => () => {
                const { own: _own, ...rest } = ctx.props;
                return jsx('div', { ...rest });
            });

            render(jsx(Comp, { own: 'x', 'client:load': true, 'data-keep': 'yes' }), container);

            const el = container.querySelector('div')!;
            expect(el.getAttribute('data-keep')).toBe('yes');
            expect(el.hasAttribute('client:load')).toBe(false);
        });

        it('does not stringify a Model-valued prop onto the element', () => {
            const store = { title: 'hello' };
            const model = createModel<string>([store, 'title'], v => { store.title = v; });

            render(jsx('div', { title: model, id: 'keep' }), container);

            const el = container.querySelector('div')!;
            expect(el.getAttribute('id')).toBe('keep');
            expect(el.hasAttribute('title')).toBe(false);
        });
    });

    describe('two spellings of one event collide', () => {
        it('warns once, naming both props and the element', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const first = vi.fn();
            const second = vi.fn();

            render(jsx('button', { onClick: first, onclick: second }), container);

            expect(warn).toHaveBeenCalledTimes(1);
            const message = String(warn.mock.calls[0][0]);
            expect(message).toContain('click');
            expect(message).toContain('onClick');
            expect(message).toContain('onclick');
            expect(message).toContain('button');

            // The collision itself is unchanged — one listener, last one wins.
            container.querySelector('button')!.click();
            expect(first).not.toHaveBeenCalled();
            expect(second).toHaveBeenCalledTimes(1);

            warn.mockRestore();
        });

        it('does not warn when a single spelling is re-patched across renders', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const Comp = component<{ n: number }>(ctx =>
                () => jsx('button', { onClick: () => void ctx.props.n }));

            render(jsx(Comp, { n: 1 }), container);
            render(jsx(Comp, { n: 2 }), container);

            expect(warn).not.toHaveBeenCalled();
            warn.mockRestore();
        });
    });
});
