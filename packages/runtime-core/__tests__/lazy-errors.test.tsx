/**
 * Error-path and Defer-fallback coverage for lazy.tsx.
 *
 * Companion to lazy-timing.test.tsx — focuses on the rejected/error branches
 * (render-throw routing through errorScope / app onError), Defer fallback
 * function-vs-JSX shapes, isLazyComponent, preload(), and isLoaded().
 * Full <Defer> behavior is covered by defer.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx, lazy, Defer, errorScope, defineApp } from 'sigx';
import { render } from '@sigx/runtime-dom';
import { isLazyComponent } from '../src/lazy';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('lazy() — loader rejection', () => {
    let container: HTMLDivElement;
    afterEach(() => { container?.remove(); });

    it('routes the loader error to the nearest errorScope fallback', async () => {
        let rejectLoader!: (err: Error) => void;
        const Boom = lazy(() => new Promise<any>((_, rej) => { rejectLoader = rej; }));

        const Host = component(() => {
            errorScope({
                fallback: (error) => <div class="err">{error.message}</div>,
            });
            return () => jsx(Boom, {});
        }, { name: 'Host' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(Host, {}), container);
        await tick();

        // Pending: renders nothing, no error yet
        expect(container.querySelector('.err')).toBeNull();

        rejectLoader(new Error('chunk-failed'));
        await tick();
        await tick();
        await wait(10);

        // The wrapper's re-render threw the load error; the scope took it
        expect(container.querySelector('.err')?.textContent).toBe('chunk-failed');
    });

    it('reaches app onError when no errorScope wraps the lazy component', async () => {
        const onError = vi.fn().mockReturnValue(true);
        let rejectLoader!: (err: Error) => void;
        const Boom = lazy(() => new Promise<any>((_, rej) => { rejectLoader = rej; }));

        container = document.createElement('div');
        document.body.appendChild(container);

        const app = defineApp(jsx(Boom, {}));
        app.onError(onError);
        app.mount(container);
        await tick();

        expect(onError).not.toHaveBeenCalled();

        rejectLoader(new Error('chunk-failed'));
        await tick();
        await tick();
        await wait(10);

        expect(onError).toHaveBeenCalledTimes(1);
        const [err, , info] = onError.mock.calls[0];
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('chunk-failed');
        expect(info).toBe('render');
    });
});

describe('Defer — mounting shapes around a lazy chunk', () => {
    // Smoke coverage of the fallback-prop shapes (JSX / function / absent),
    // mirroring the old Suspense shape tests. Full <Defer> fallback display
    // behavior is defer.test.tsx's territory.
    let container: HTMLDivElement;
    afterEach(() => { container?.remove(); });

    it('mounts with a JSX fallback and a pending lazy child without throwing', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        container = document.createElement('div');
        document.body.appendChild(container);
        expect(() => render(
            jsx(Defer, {
                fallback: jsx('span', { class: 'fb' }, 'loading...'),
                children: [jsx(Slow, {})]
            }),
            container
        )).not.toThrow();
        await tick();
    });

    it('mounts with a function fallback and a pending lazy child without throwing', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        const fallbackFn = vi.fn(() => jsx('span', { class: 'fb-fn' }, 'loading'));
        container = document.createElement('div');
        document.body.appendChild(container);
        expect(() => render(
            jsx(Defer, {
                fallback: fallbackFn,
                children: [jsx(Slow, {})]
            }),
            container
        )).not.toThrow();
        await tick();
    });

    it('renders a comment placeholder in the fallback slot with no fallback prop', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        container = document.createElement('div');
        document.body.appendChild(container);
        expect(() => render(
            jsx(Defer, { children: [jsx(Slow, {})] }),
            container
        )).not.toThrow();
        await tick();
        await tick();

        // Constant shape: a null fallback slot normalizes to a comment node
        expect(container.innerHTML).toContain('<!---->');
    });

    it('mounts children through the default slot including mixed falsy entries', async () => {
        const Cmp = component(() => () => jsx('span', { class: 'ok' }, 'ok'), { name: 'OkCmp' });
        container = document.createElement('div');
        document.body.appendChild(container);

        render(
            jsx(Defer, {
                children: [null, false, true, jsx(Cmp, {}), null]
            }),
            container
        );
        await tick();
        await tick();
        await wait(20);
        // Nothing pending — children render directly, falsy entries skipped
        expect(container.querySelector('.ok')).not.toBeNull();
    });

    it('keeps children mounted and swaps the resolved component in place', async () => {
        const Inner = component(() => () => jsx('div', { class: 'inner', children: 'loaded' }), { name: 'Inner' });
        let resolveLoader!: (mod: any) => void;
        const Slow = lazy(() => new Promise<any>(r => { resolveLoader = r; }));

        container = document.createElement('div');
        document.body.appendChild(container);
        render(
            jsx(Defer, {
                fallback: jsx('span', { class: 'fb' }, 'loading...'),
                children: [jsx(Slow, {}), jsx('p', { class: 'sibling', children: 'stays' })]
            }),
            container
        );
        await tick();
        await tick();
        // Pending lazy renders null; the sibling child is already mounted
        expect(container.querySelector('.inner')).toBeNull();
        expect(container.querySelector('.sibling')?.textContent).toBe('stays');

        resolveLoader({ default: Inner });
        await tick();
        await tick();
        await wait(10);

        // Resolved component appears in place; sibling stayed mounted;
        // the fallback slot holds a comment node (constant render shape)
        expect(container.querySelector('.fb')).toBeNull();
        expect(container.querySelector('.inner')?.textContent).toBe('loaded');
        expect(container.querySelector('.sibling')?.textContent).toBe('stays');
        expect(container.innerHTML).toContain('<!---->');
    });
});

describe('isLazyComponent', () => {
    it('returns true for lazy() wrappers', () => {
        const L = lazy(() => Promise.resolve({ default: component(() => () => null) }));
        expect(isLazyComponent(L)).toBe(true);
    });

    it('returns false for ordinary components', () => {
        const C = component(() => () => null);
        expect(isLazyComponent(C)).toBe(false);
    });

    it('returns a falsy value for null/undefined and primitives', () => {
        // Implementation is `component && component.__lazy === true` so null/undefined
        // short-circuit to the original (falsy) value rather than false.
        expect(isLazyComponent(null)).toBeFalsy();
        expect(isLazyComponent(undefined)).toBeFalsy();
        expect(isLazyComponent(42)).toBeFalsy();
    });
});

describe('lazy().preload() and isLoaded()', () => {
    it('preload triggers loading without a mount and isLoaded reflects state', async () => {
        const Cmp = component(() => () => jsx('span', {}, 'x'));
        const L = lazy<typeof Cmp>(() => Promise.resolve({ default: Cmp }));

        expect(L.isLoaded()).toBe(false);
        const resolved = await L.preload();
        expect(L.isLoaded()).toBe(true);
        expect(resolved).toBe(Cmp);
    });

    it('preload returns the same promise on repeated calls (cached)', async () => {
        const Cmp = component(() => () => null);
        const L = lazy<typeof Cmp>(() => Promise.resolve({ default: Cmp }));
        const p1 = L.preload();
        const p2 = L.preload();
        expect(p1).toBe(p2);
        await p1;
    });

    it('preload sets state to rejected when loader fails', async () => {
        const L = lazy<any>(() => Promise.reject(new Error('preload-fail')));
        await expect(L.preload()).rejects.toThrow('preload-fail');
        expect(L.isLoaded()).toBe(false);
    });

    it('handles non-Error rejections by wrapping in Error', async () => {
        const L = lazy<any>(() => Promise.reject('a-string-error' as any));
        await expect(L.preload()).rejects.toThrow('a-string-error');
    });

    it('supports loaders that return the component directly (no .default key)', async () => {
        const Cmp = component(() => () => null);
        // Loader returns the component itself rather than { default: ... }
        const L = lazy(() => Promise.resolve(Cmp as any));
        const resolved = await L.preload();
        expect(resolved).toBe(Cmp);
    });
});

describe('lazy() — factory-level shared load state', () => {
    it('every mounted instance re-renders when the shared chunk settles', async () => {
        let resolveLoader!: (mod: any) => void;
        const Cmp = component(() => () => jsx('span', { class: 'shared' }, 'ok'));
        const L = lazy<typeof Cmp>(() => new Promise<any>(r => { resolveLoader = r; }));

        const c1 = document.createElement('div');
        const c2 = document.createElement('div');
        document.body.appendChild(c1);
        document.body.appendChild(c2);

        try {
            render(jsx(L, {}), c1);
            render(jsx(L, {}), c2);
            await tick();
            expect(c1.querySelector('.shared')).toBeNull();
            expect(c2.querySelector('.shared')).toBeNull();

            // One factory-level signal: resolving the single in-flight promise
            // must flip BOTH mounted instances, not just the first subscriber.
            resolveLoader({ default: Cmp });
            await tick(); await tick(); await wait(10);

            expect(c1.querySelector('.shared')).not.toBeNull();
            expect(c2.querySelector('.shared')).not.toBeNull();
        } finally {
            c1.remove();
            c2.remove();
        }
    });
});
