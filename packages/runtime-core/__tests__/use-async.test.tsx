/**
 * Tests for useAsync() composable.
 *
 * Verifies loading states, Suspense integration, error handling,
 * and cleanup on unmount.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { component, signal, jsx, useAsync, Suspense, type ComponentFactory } from 'sigx';
import { render } from '@sigx/runtime-dom';

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

describe('useAsync', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        container?.remove();
    });

    // ========================================================================
    // Basic loading → resolved
    // ========================================================================

    it('should show loading then resolved content', async () => {
        let resolve!: (val: string) => void;

        const App = component(() => {
            const data = useAsync<string>(() => new Promise<string>(r => { resolve = r; }));
            return () =>
                data.loading
                    ? <div class="loading">Loading</div>
                    : <div class="content">{data.value}</div>;
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        expect(container.querySelector('.loading')).toBeTruthy();
        expect(container.querySelector('.content')).toBeNull();

        resolve('hello world');
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.content')).toBeTruthy();
        expect(container.querySelector('.content')?.textContent).toBe('hello world');
        expect(container.querySelector('.loading')).toBeNull();
    });

    // ========================================================================
    // Suspense compatibility
    // ========================================================================

    it('should not break when wrapped in Suspense', async () => {
        let resolve!: (val: number) => void;

        const Child = component(() => {
            const data = useAsync<number>(() => new Promise<number>(r => { resolve = r; }));
            return () =>
                data.loading
                    ? <div class="child-loading">Loading child…</div>
                    : <div class="child">Value: {data.value}</div>;
        }, { name: 'Child' });

        container = document.createElement('div');
        document.body.appendChild(container);

        render(
            jsx(Suspense, {
                fallback: () => <div class="fallback">Loading…</div>,
                children: [jsx(Child, {})]
            }),
            container
        );

        await tick();

        // Component renders its own loading state (Suspense doesn't intercept)
        expect(container.querySelector('.child-loading')).toBeTruthy();
        expect(container.querySelector('.child')).toBeNull();

        resolve(42);
        await tick();
        await tick();
        await wait(20);

        // After resolve, shows the real content
        expect(container.querySelector('.child')).toBeTruthy();
        expect(container.querySelector('.child')?.textContent).toBe('Value: 42');
        expect(container.querySelector('.child-loading')).toBeNull();
    });

    // ========================================================================
    // Error handling
    // ========================================================================

    it('should handle errors', async () => {
        let reject!: (err: Error) => void;

        const App = component(() => {
            const data = useAsync<string>(() => new Promise<string>((_, r) => { reject = r; }));
            return () =>
                data.error
                    ? <div class="error">{data.error.message}</div>
                    : data.loading
                        ? <div class="loading">Loading</div>
                        : <div class="content">{data.value}</div>;
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        expect(container.querySelector('.loading')).toBeTruthy();

        reject(new Error('network failure'));
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.error')).toBeTruthy();
        expect(container.querySelector('.error')?.textContent).toBe('network failure');
        expect(container.querySelector('.loading')).toBeNull();
        expect(container.querySelector('.content')).toBeNull();
    });

    it('should convert non-Error rejections to Error', async () => {
        let reject!: (err: any) => void;

        const App = component(() => {
            const data = useAsync<string>(() => new Promise<string>((_, r) => { reject = r; }));
            return () =>
                data.error
                    ? <div class="error">{data.error.message}</div>
                    : <div class="loading">Loading</div>;
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        reject('string error');
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.error')?.textContent).toBe('string error');
    });

    // ========================================================================
    // Unmount before resolve
    // ========================================================================

    it('should not throw if unmounted before resolve', async () => {
        let resolve!: (val: string) => void;

        const App = component(() => {
            const data = useAsync<string>(() => new Promise<string>(r => { resolve = r; }));
            return () => <div class="app">{data.loading ? 'loading' : data.value}</div>;
        }, { name: 'App' });

        const show = signal({ value: true });

        const Wrapper = component(() => {
            return () => show.value ? jsx(App, {}) : <div class="gone">Gone</div>;
        }, { name: 'Wrapper' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(Wrapper, {}), container);

        expect(container.querySelector('.app')).toBeTruthy();

        // Unmount the component
        show.value = false;
        await tick();
        expect(container.querySelector('.gone')).toBeTruthy();

        // Resolve after unmount — should NOT throw
        resolve('too late');
        await tick();
        await tick();
        await wait(10);

        // Wrapper still shows .gone
        expect(container.querySelector('.gone')).toBeTruthy();
    });

    // ========================================================================
    // Multiple useAsync in one component
    // ========================================================================

    it('should handle multiple useAsync calls in one component', async () => {
        let resolveA!: (val: string) => void;
        let resolveB!: (val: number) => void;

        const App = component(() => {
            const dataA = useAsync<string>(() => new Promise<string>(r => { resolveA = r; }));
            const dataB = useAsync<number>(() => new Promise<number>(r => { resolveB = r; }));

            return () => (
                <div class="app">
                    <span class="a">{dataA.loading ? 'loading-a' : dataA.value}</span>
                    <span class="b">{dataB.loading ? 'loading-b' : String(dataB.value)}</span>
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        expect(container.querySelector('.a')?.textContent).toBe('loading-a');
        expect(container.querySelector('.b')?.textContent).toBe('loading-b');

        // Resolve A first
        resolveA('alpha');
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.a')?.textContent).toBe('alpha');
        expect(container.querySelector('.b')?.textContent).toBe('loading-b');

        // Resolve B
        resolveB(99);
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.a')?.textContent).toBe('alpha');
        expect(container.querySelector('.b')?.textContent).toBe('99');
    });

    // ========================================================================
    // Immediate resolution (cached / already-resolved promise)
    // ========================================================================

    it('should handle synchronously-resolved promise', async () => {
        const App = component(() => {
            const data = useAsync(() => Promise.resolve('instant'));
            return () =>
                data.loading
                    ? <div class="loading">Loading</div>
                    : <div class="content">{data.value}</div>;
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        // Promise.resolve is still async (microtask), so first render shows loading
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.content')).toBeTruthy();
        expect(container.querySelector('.content')?.textContent).toBe('instant');
    });

    // ========================================================================
    // Dynamic import use case (the primary motivation)
    // ========================================================================

    it('should work with dynamic import pattern', async () => {
        // Simulate dynamic import that returns a module with a class
        const fakeModule = {
            Editor: class FakeEditor {
                constructor(public el: HTMLElement) { }
                getValue() { return 'editor-content'; }
            }
        };

        const App = component(({ signal: s }) => {
            const mod = useAsync(() => Promise.resolve(fakeModule));
            const state = s({ text: '' });

            return () => {
                if (mod.loading) return <div class="skeleton">Loading editor...</div>;
                // Access the loaded module
                state.text = new mod.value!.Editor(document.createElement('div')).getValue();
                return <div class="editor">{state.text}</div>;
            };
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.editor')).toBeTruthy();
        expect(container.querySelector('.editor')?.textContent).toBe('editor-content');
    });
});
