/**
 * Tests for the useAsync()/useStream() composables (default client semantics).
 *
 * Covers unkeyed loading/error states, keyed restoration from the
 * server-emitted __SIGX_ASYNC__ blob (consume-once), keyed in-flight dedupe,
 * refresh(), throwOnError, outside-setup guards, Suspense compatibility,
 * cleanup on unmount, and useStream live accumulation/restoration.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, useAsync, useStream, Suspense, type AsyncState } from 'sigx';
import { render } from '@sigx/runtime-dom';

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await wait(10);
}

describe('useAsync', () => {
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
        // Consume-once blob + module-level inflight map are global: reset
        delete (globalThis as any).__SIGX_ASYNC__;
    });

    // ========================================================================
    // Unkeyed: basic loading → resolved
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

        const container = mount(jsx(App, {}));

        expect(container.querySelector('.loading')).toBeTruthy();
        expect(container.querySelector('.content')).toBeNull();

        resolve('hello world');
        await settle();

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

        const container = mount(
            jsx(Suspense, {
                fallback: () => <div class="fallback">Loading…</div>,
                children: [jsx(Child, {})]
            })
        );

        await tick();

        // Component renders its own loading state (Suspense doesn't intercept)
        expect(container.querySelector('.child-loading')).toBeTruthy();
        expect(container.querySelector('.child')).toBeNull();

        resolve(42);
        await settle();
        await wait(10);

        expect(container.querySelector('.child')).toBeTruthy();
        expect(container.querySelector('.child')?.textContent).toBe('Value: 42');
        expect(container.querySelector('.child-loading')).toBeNull();
    });

    // ========================================================================
    // Error handling
    // ========================================================================

    it('should capture fetch errors in .error', async () => {
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

        const container = mount(jsx(App, {}));

        expect(container.querySelector('.loading')).toBeTruthy();

        reject(new Error('network failure'));
        await settle();

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

        const container = mount(jsx(App, {}));

        reject('string error');
        await settle();

        expect(container.querySelector('.error')?.textContent).toBe('string error');
    });

    it('throwOnError: reading .error throws the captured failure', async () => {
        let state!: AsyncState<string>;
        let reject!: (err: Error) => void;

        const App = component(() => {
            state = useAsync<string>(
                () => new Promise<string>((_, r) => { reject = r; }),
                { throwOnError: true }
            );
            // Render must NOT touch .error — it would throw into the renderer
            return () => <div class="app">{state.loading ? 'loading' : 'done'}</div>;
        }, { name: 'App' });

        mount(jsx(App, {}));

        reject(new Error('boom'));
        await settle();

        expect(() => state.error).toThrow('boom');
        expect(state.loading).toBe(false);
        expect(state.value).toBeNull();
    });

    // ========================================================================
    // Outside-setup guard
    // ========================================================================

    it('throws when called outside component setup', () => {
        expect(() => useAsync(async () => 'x')).toThrow(/setup/);
        expect(() => useAsync('some-key', async () => 'x')).toThrow(/setup/);
    });

    // ========================================================================
    // Keyed: restore from the server blob (consume-once)
    // ========================================================================

    it('restores a keyed value from __SIGX_ASYNC__ without fetching; second mount refetches', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { 'restore-key': 'from-server' };
        const fetcher = vi.fn(async () => 'from-client');

        const App = component(() => {
            const data = useAsync('restore-key', fetcher);
            return () => (
                <div class="v">
                    {data.value ?? (data.loading ? 'loading' : 'none')}
                </div>
            );
        }, { name: 'App' });

        // First mount consumes the blob entry: no fetch, value synchronously
        const first = mount(jsx(App, {}));
        expect(first.querySelector('.v')?.textContent).toBe('from-server');
        expect(fetcher).not.toHaveBeenCalled();
        // Consume-once: the entry is gone
        expect('restore-key' in (globalThis as any).__SIGX_ASYNC__).toBe(false);

        // Second mount of the same key: blob exhausted → fetches fresh data
        const second = mount(jsx(App, {}));
        expect(second.querySelector('.v')?.textContent).toBe('loading');
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(second.querySelector('.v')?.textContent).toBe('from-client');
    });

    // ========================================================================
    // Keyed: in-flight dedupe across concurrent mounts
    // ========================================================================

    it('dedupes concurrent keyed fetches — one fetcher call shared by two mounts', async () => {
        let resolve!: (val: string) => void;
        const fetcher = vi.fn(() => new Promise<string>(r => { resolve = r; }));

        const Card = component(() => {
            const data = useAsync('dedupe-client-key', fetcher);
            return () => <span class="card">{data.value ?? 'loading'}</span>;
        }, { name: 'Card' });

        const App = component(() => {
            return () => (
                <div>
                    {jsx(Card, {})}
                    {jsx(Card, {})}
                </div>
            );
        }, { name: 'App' });

        const container = mount(jsx(App, {}));

        expect(fetcher).toHaveBeenCalledTimes(1);

        resolve('shared');
        await settle();

        const cards = container.querySelectorAll('.card');
        expect(cards.length).toBe(2);
        expect(cards[0].textContent).toBe('shared');
        expect(cards[1].textContent).toBe('shared');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // ========================================================================
    // refresh()
    // ========================================================================

    it('refresh() re-runs the fetcher and updates the value', async () => {
        let state!: AsyncState<number>;
        let count = 0;
        const fetcher = vi.fn(async () => ++count);

        const App = component(() => {
            state = useAsync<number>(fetcher);
            return () => <div class="n">{state.value ?? 'loading'}</div>;
        }, { name: 'App' });

        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.n')?.textContent).toBe('1');
        expect(fetcher).toHaveBeenCalledTimes(1);

        await state.refresh();
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(container.querySelector('.n')?.textContent).toBe('2');
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

        const container = mount(jsx(Wrapper, {}));

        expect(container.querySelector('.app')).toBeTruthy();

        // Unmount the component
        show.value = false;
        await tick();
        expect(container.querySelector('.gone')).toBeTruthy();

        // Resolve after unmount — should NOT throw
        resolve('too late');
        await settle();

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

        const container = mount(jsx(App, {}));

        expect(container.querySelector('.a')?.textContent).toBe('loading-a');
        expect(container.querySelector('.b')?.textContent).toBe('loading-b');

        resolveA('alpha');
        await settle();

        expect(container.querySelector('.a')?.textContent).toBe('alpha');
        expect(container.querySelector('.b')?.textContent).toBe('loading-b');

        resolveB(99);
        await settle();

        expect(container.querySelector('.a')?.textContent).toBe('alpha');
        expect(container.querySelector('.b')?.textContent).toBe('99');
    });

    // ========================================================================
    // Dynamic import use case
    // ========================================================================

    it('should work with dynamic import pattern', async () => {
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
                state.text = new mod.value!.Editor(document.createElement('div')).getValue();
                return <div class="editor">{state.text}</div>;
            };
        }, { name: 'App' });

        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.editor')).toBeTruthy();
        expect(container.querySelector('.editor')?.textContent).toBe('editor-content');
    });
});

describe('useStream', () => {
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
        delete (globalThis as any).__SIGX_ASYNC__;
    });

    async function* tokens(parts: string[]): AsyncGenerator<string> {
        for (const part of parts) {
            await new Promise(r => setTimeout(r, 1));
            yield part;
        }
    }

    it('accumulates source chunks live on the client', async () => {
        const App = component(() => {
            const text = useStream('live-stream', () => tokens(['Hello', ', ', 'world']));
            return () => <div class="out">{text.value}</div>;
        }, { name: 'App' });

        const container = mount(jsx(App, {}));

        expect(container.querySelector('.out')?.textContent).toBe('');

        await wait(30);
        await tick();

        expect(container.querySelector('.out')?.textContent).toBe('Hello, world');
    });

    it('restores the final text from __SIGX_ASYNC__ without running the source', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { 'restored-stream': 'final server text' };
        const sourceSpy = vi.fn(() => tokens(['should', 'not', 'run']));

        const App = component(() => {
            const text = useStream('restored-stream', sourceSpy);
            return () => <div class="out">{text.value}</div>;
        }, { name: 'App' });

        const container = mount(jsx(App, {}));

        expect(container.querySelector('.out')?.textContent).toBe('final server text');
        expect(sourceSpy).not.toHaveBeenCalled();
        // Consume-once
        expect('restored-stream' in (globalThis as any).__SIGX_ASYNC__).toBe(false);
    });

    it('throws when called outside component setup', () => {
        expect(() => useStream('k', () => tokens(['x']))).toThrow(/setup/);
    });
});
