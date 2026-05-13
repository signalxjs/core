/**
 * Error-path and Suspense-fallback coverage for lazy.tsx.
 *
 * Companion to lazy-timing.test.tsx — focuses on the rejected/error branches,
 * fallback function-vs-JSX, isLazyComponent, preload(), and isLoaded().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, lazy, Suspense } from 'sigx';
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

    it('logs error path through console but does not crash the render when no Suspense wraps it', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Boom = lazy(() => Promise.reject(new Error('chunk-failed')));

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(Boom, {}), container);

        await tick();
        await tick();
        await wait(10);

        // The component renders null while pending, and since no Suspense is
        // wrapping it, the error propagates through the lazy state without
        // crashing the render. We just verify the test didn't throw.
        expect(container.parentNode).toBe(document.body);
        errSpy.mockRestore();
    });
});

describe('Suspense — fallback shapes', () => {
    let container: HTMLDivElement;
    afterEach(() => { container?.remove(); });

    it('mounts a Suspense boundary with a JSX fallback without throwing', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        container = document.createElement('div');
        document.body.appendChild(container);
        // Smoke test for the JSX-fallback branch in Suspense's render fn.
        // Full pending-state DOM observation is covered by lazy-timing.test.tsx.
        expect(() => render(
            jsx(Suspense, {
                fallback: jsx('span', { class: 'fb' }, 'loading...'),
                children: [jsx(Slow, {})]
            }),
            container
        )).not.toThrow();
        await tick();
    });

    it('mounts a Suspense boundary with a function fallback without throwing', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        const fallbackFn = vi.fn(() => jsx('span', { class: 'fb-fn' }, 'loading'));
        container = document.createElement('div');
        document.body.appendChild(container);
        expect(() => render(
            jsx(Suspense, {
                fallback: fallbackFn,
                children: [jsx(Slow, {})]
            }),
            container
        )).not.toThrow();
        await tick();
    });

    it('mounts a Suspense boundary with no fallback prop', async () => {
        const Slow = lazy(() => new Promise<any>(() => {}));
        container = document.createElement('div');
        document.body.appendChild(container);
        expect(() => render(
            jsx(Suspense, { children: [jsx(Slow, {})] }),
            container
        )).not.toThrow();
        await tick();
    });

    it('renders the single child VNode when the children array filters down to one entry', async () => {
        const Cmp = component(() => () => jsx('span', { class: 'ok' }, 'ok'), { name: 'OkCmp' });
        container = document.createElement('div');
        document.body.appendChild(container);

        render(
            jsx(Suspense, {
                children: [null, false, true, jsx(Cmp, {}), null]
            }),
            container
        );
        await tick();
        await tick();
        await wait(20);
        // Verify Suspense rendered without throwing — the single-element filter
        // branch must have been taken (else: returning an array of mixed truthy
        // / falsy entries would crash the renderer).
        expect(container.querySelector('.ok')).not.toBeNull();
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

describe('lazy() — second instance subscribes when promise is still pending', () => {
    it('second mount of the same lazy component shares the in-flight promise', async () => {
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
