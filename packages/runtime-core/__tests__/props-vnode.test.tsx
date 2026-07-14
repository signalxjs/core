/**
 * Regression tests for #191: an element vnode passed as a component PROP
 * must reach the renderer as its RAW object. The reactive props proxy used
 * to wrap it (and, transitively, its dom node), corrupting the renderer's
 * bookkeeping: toggling the vnode out of the tree removed its text child
 * but left the element, misplaced later mounts, and threw inside happy-dom
 * (`removeChild ... is not a child of this node`) on re-show/unmount.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { component, signal, jsx, Fragment, type JSXElement, type Define } from 'sigx';
import { toRaw } from '@sigx/reactivity';
import { render } from '@sigx/runtime-dom';

async function settle(): Promise<void> {
    await new Promise<void>(r => queueMicrotask(r));
    await new Promise(r => setTimeout(r, 10));
}

describe('vnode props reach the renderer raw (#191)', () => {
    const containers: HTMLDivElement[] = [];

    function mount(node: any): HTMLDivElement {
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);
        render(node, container);
        return container;
    }

    afterEach(() => {
        for (const c of containers.splice(0)) c.remove();
    });

    it('ctx.props returns the identical raw vnode object', () => {
        const fb = <div class="fb">Loading…</div>;
        let seen: unknown;
        type P = Define.Prop<'fb', JSXElement>;
        const Box = component<P>((ctx) => {
            seen = ctx.props.fb;
            return () => <div />;
        });
        const App = component(() => () => jsx(Box as any, { fb }));
        mount(jsx(App, {}));

        expect(seen).toBe(fb);            // identity, not a proxy
        expect(toRaw(seen as object)).toBe(seen);
    });

    it('a text-childed element vnode prop toggles in and out cleanly (the #191 repro)', async () => {
        const show = signal({ value: false });
        type P = Define.Prop<'fb', JSXElement>;
        const Box = component<P>((ctx) => () =>
            jsx(Fragment, { children: [show.value ? ctx.props.fb : null, [<span class="x">x</span>]] })
        );
        const App = component(() => () => jsx(Box as any, { fb: <div class="fb">Loading…</div> }));
        const container = mount(jsx(App, {}));

        show.value = true;
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('Loading…');
        expect(container.querySelector('.x')).toBeTruthy();

        show.value = false;
        await settle();
        expect(container.querySelector('.fb')).toBeNull(); // fully unmounted
        expect(container.querySelector('.x')).toBeTruthy();

        // Re-show: the SAME vnode object mounts again with fresh bookkeeping
        show.value = true;
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('Loading…');

        show.value = false;
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
    });

    it('an ARRAY of vnodes passed as a prop is returned raw and renders/toggles cleanly', async () => {
        const show = signal({ value: true });
        type P = Define.Prop<'items', JSXElement[]>;
        const List = component<P>((ctx) => () =>
            jsx(Fragment, { children: [show.value ? ctx.props.items : null] })
        );
        const items = [<li class="a">a</li>, <li class="b">b</li>];
        const App = component(() => () => jsx(List as any, { items }));
        const container = mount(jsx(App, {}));

        expect(container.querySelector('.a')?.textContent).toBe('a');
        expect(container.querySelector('.b')?.textContent).toBe('b');

        show.value = false;
        await settle();
        expect(container.querySelector('.a')).toBeNull();
        expect(container.querySelector('.b')).toBeNull();

        show.value = true;
        await settle();
        expect(container.querySelector('.a')?.textContent).toBe('a');
    });

    it('plain object props stay reactive (unwrap applies to vnodes only)', async () => {
        const state = signal({ user: { name: 'Ada' } });
        type P = Define.Prop<'user', { name: string }>;
        const Who = component<P>((ctx) => () => <div class="who">{ctx.props.user?.name}</div>);
        const App = component(() => () => jsx(Who as any, { user: state.user }));
        const container = mount(jsx(App, {}));

        expect(container.querySelector('.who')?.textContent).toBe('Ada');
        state.user.name = 'Grace';
        await settle();
        expect(container.querySelector('.who')?.textContent).toBe('Grace');
    });

    it('<Defer> element fallback (with text) works without the old toRaw workaround', async () => {
        const { lazy, Defer } = await import('sigx');
        let resolveModule!: (mod: any) => void;
        const Late = lazy(() => new Promise<any>(r => { resolveModule = r; }));
        const Inner = component(() => () => <div class="late">late</div>);

        const App = component(() => () => (
            <Defer fallback={<div class="fb">Loading…</div>}>
                {jsx(Late, {})}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('Loading…');

        resolveModule(Inner);
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.late')?.textContent).toBe('late');
    });
});
