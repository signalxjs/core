/**
 * Spread-forwarding across a component boundary (#521).
 *
 * `{...ctx.props}` and rest destructuring enumerate the props object. Before
 * key-set reactivity that enumeration created no dependency on the key set,
 * so a prop the parent had never passed before was invisible to the child:
 * the render effect had no dep for the new key to trigger. Removal already
 * worked, because the spread's per-key `get` had created that dep.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('spread forwarding sees a newly-added prop key', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    const keysOf = (props: Record<string, any>) =>
        Object.keys(props).filter(k => k !== 'children').sort().join(',');

    it('forwards a key that appears after the first render', () => {
        const Child = component<Record<string, any>>(ctx =>
            () => jsx('span', { children: keysOf(ctx.props) }));

        const Wrapper = component<Record<string, any>>(ctx =>
            () => jsx(Child, { ...ctx.props }));

        const extra = signal<Record<string, any>>({});
        const Parent = component(() => () => jsx(Wrapper, { a: 1, ...extra }));

        render(jsx(Parent, {}), container);
        expect(container.textContent).toBe('a');

        extra.title = 'x';
        expect(container.textContent).toBe('a,title');
    });

    it('drops a key that disappears', () => {
        const Child = component<Record<string, any>>(ctx =>
            () => jsx('span', { children: keysOf(ctx.props) }));

        const Wrapper = component<Record<string, any>>(ctx =>
            () => jsx(Child, { ...ctx.props }));

        const extra = signal<Record<string, any>>({ title: 'x' });
        const Parent = component(() => () => jsx(Wrapper, { a: 1, ...extra }));

        render(jsx(Parent, {}), container);
        expect(container.textContent).toBe('a,title');

        delete extra.title;
        expect(container.textContent).toBe('a');
    });

    it('rest destructuring onto an element picks up a new attribute', () => {
        const Comp = component<Record<string, any>>(ctx => () => {
            const { own: _own, ...rest } = ctx.props;
            return jsx('button', { ...rest });
        });

        const extra = signal<Record<string, any>>({});
        const Parent = component(() => () => jsx(Comp, { own: 'consumed', ...extra }));

        render(jsx(Parent, {}), container);
        const el = container.querySelector('button')!;
        expect(el.hasAttribute('data-density')).toBe(false);
        expect(el.getAttribute('own')).toBe(null);

        extra['data-density'] = 'compact';
        expect(el.getAttribute('data-density')).toBe('compact');

        extra['data-density'] = 'roomy';
        expect(el.getAttribute('data-density')).toBe('roomy');

        delete extra['data-density'];
        expect(el.hasAttribute('data-density')).toBe(false);
    });

    it('a value-only change still does not re-render an enumerating child', () => {
        let childRenders = 0;
        const Child = component<Record<string, any>>(ctx => () => {
            childRenders++;
            return jsx('span', { children: keysOf(ctx.props) });
        });

        const Wrapper = component<Record<string, any>>(ctx =>
            () => jsx(Child, { ...ctx.props }));

        const extra = signal<Record<string, any>>({ title: 'x' });
        const Parent = component(() => () => jsx(Wrapper, { ...extra }));

        render(jsx(Parent, {}), container);
        const afterMount = childRenders;

        // Same key set, different value: the child renders because it read
        // the value, not because the key set moved. What must NOT happen is
        // a second, redundant run from the iteration dep.
        extra.title = 'y';
        expect(childRenders).toBe(afterMount + 1);
    });
});
