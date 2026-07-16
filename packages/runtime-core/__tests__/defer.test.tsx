/**
 * Tests for <Defer fallback> — the thin client boundary for lazy() chunk
 * loading (docs/rfc-async.md §5). Client-side it covers CHUNKS ONLY; data
 * pending renders through the owning component's match.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { component, signal, jsx, lazy, Defer, errorScope, type AnyComponentFactory } from 'sigx';
import { render } from '@sigx/runtime-dom';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

/** A lazy factory whose module resolution is manually controlled. */
function deferredLazy(name: string) {
    let resolveModule!: (mod: AnyComponentFactory) => void;
    let rejectModule!: (e: Error) => void;
    const factory = lazy(() => new Promise<AnyComponentFactory>((res, rej) => {
        resolveModule = res;
        rejectModule = rej;
    }));
    const Inner = component(() => () => <div class={name}>{name}</div>, { name });
    return {
        factory,
        resolve: () => resolveModule(Inner),
        reject: (e: Error) => rejectModule(e),
    };
}

describe('<Defer>', () => {
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

    it('shows the fallback while a lazy child loads, then the content in place', async () => {
        const { factory: Chart, resolve } = deferredLazy('chart');

        const App = component(() => () => (
            <Defer fallback={<div class="fb">Loading…</div>}>
                {jsx(Chart, {})}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.fb')).toBeTruthy();
        expect(container.querySelector('.chart')).toBeNull();

        resolve();
        await settle();

        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.chart')?.textContent).toBe('chart');
    });

    it('accepts a function fallback', async () => {
        const { factory: Late, resolve } = deferredLazy('late');
        const App = component(() => () => (
            <Defer fallback={() => <div class="fb">fn fallback</div>}>
                {jsx(Late, {})}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('fn fallback');
        resolve();
        await settle();
        expect(container.querySelector('.late')).toBeTruthy();
    });

    it('non-lazy siblings stay MOUNTED while the chunk loads (constant shape)', async () => {
        const { factory: Slow, resolve } = deferredLazy('slow');
        let siblingSetups = 0;

        const Sibling = component((ctx) => {
            siblingSetups++;
            const count = ctx.signal(0);
            return () => (
                <button class="sib" onClick={() => count.value++}>
                    {count.value}
                </button>
            );
        });

        const App = component(() => () => (
            <Defer fallback={<div class="fb" />}>
                {jsx(Sibling, {})}
                {jsx(Slow, {})}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();

        // Sibling mounted once, alive under the fallback
        expect(siblingSetups).toBe(1);
        const btn = container.querySelector('.sib') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        await settle();
        expect(btn.textContent).toBe('1');

        resolve();
        await settle();

        // Chunk arrived — sibling NOT remounted, its state survives
        expect(siblingSetups).toBe(1);
        expect(container.querySelector('.sib')?.textContent).toBe('1');
        expect(container.querySelector('.slow')).toBeTruthy();
        expect(container.querySelector('.fb')).toBeNull();
    });

    it('no pending chunks ⇒ children render immediately, no fallback flash', async () => {
        const App = component(() => () => (
            <Defer fallback={<div class="fb" />}>
                <div class="static">plain</div>
            </Defer>
        ));
        const container = mount(jsx(App, {}));

        expect(container.querySelector('.static')).toBeTruthy();
        expect(container.querySelector('.fb')).toBeNull();
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
    });

    it('two instances of one lazy factory count as ONE pending chunk', async () => {
        const { factory: Twice, resolve } = deferredLazy('twice');
        const App = component(() => () => (
            <Defer fallback={<div class="fb" />}>
                {jsx(Twice, {})}
                {jsx(Twice, {})}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelectorAll('.fb')).toHaveLength(1);

        resolve();
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelectorAll('.twice')).toHaveLength(2);
    });

    it('nested Defer: the NEAREST boundary covers its lazy child', async () => {
        const { factory: InnerLazy, resolve } = deferredLazy('inner-lazy');
        const App = component(() => () => (
            <Defer fallback={<div class="outer-fb" />}>
                <div class="outer-content">outer</div>
                <Defer fallback={<div class="inner-fb" />}>
                    {jsx(InnerLazy, {})}
                </Defer>
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        await settle();

        // Only the inner boundary shows a fallback; outer content renders
        expect(container.querySelector('.outer-fb')).toBeNull();
        expect(container.querySelector('.outer-content')).toBeTruthy();
        expect(container.querySelector('.inner-fb')).toBeTruthy();

        resolve();
        await settle();
        expect(container.querySelector('.inner-fb')).toBeNull();
        expect(container.querySelector('.inner-lazy')).toBeTruthy();
    });

    it('a lazy mounted under Defer AFTER an earlier resolution re-shows the fallback', async () => {
        const first = deferredLazy('first');
        const second = deferredLazy('second');
        const showSecond = signal({ value: false });

        const App = component(() => () => (
            <Defer fallback={<div class="fb" />}>
                {jsx(first.factory, {})}
                {showSecond.value ? jsx(second.factory, {}) : null}
            </Defer>
        ));
        const container = mount(jsx(App, {}));
        first.resolve();
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.first')).toBeTruthy();

        showSecond.value = true;
        await settle();
        expect(container.querySelector('.fb')).toBeTruthy(); // covering again

        second.resolve();
        await settle();
        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.second')).toBeTruthy();
    });

    it('unmounting Defer while a chunk is pending is harmless when the chunk settles', async () => {
        const { factory: Gone, resolve } = deferredLazy('gone');
        const show = signal({ value: true });
        const App = component(() => () => (
            show.value
                ? <Defer fallback={<div class="fb" />}>{jsx(Gone, {})}</Defer>
                : <div class="empty" />
        ));
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.fb')).toBeTruthy();

        show.value = false;
        await settle();
        resolve(); // settles after the boundary is gone
        await settle();
        expect(container.querySelector('.empty')).toBeTruthy();
    });

    it('a rejected chunk clears the fallback and routes the error to the enclosing errorScope', async () => {
        const { factory: Broken, reject } = deferredLazy('broken');

        const Scoped = component(() => {
            errorScope({
                fallback: (e) => <div class="err">caught: {e.message}</div>,
            });
            return () => (
                <Defer fallback={<div class="fb" />}>
                    {jsx(Broken, {})}
                </Defer>
            );
        });
        const container = mount(jsx(Scoped, {}));
        await settle();
        expect(container.querySelector('.fb')).toBeTruthy();

        reject(new Error('chunk 404'));
        await settle();

        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.err')?.textContent).toBe('caught: chunk 404');
    });
});
