/**
 * Tests for useStream() — default client semantics (unchanged by the
 * value-first async redesign; cases carried over from the retired
 * use-async.test.tsx verbatim).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, useStream } from 'sigx';
import { render } from '@sigx/runtime-dom';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

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

        // The chunks arrive on real setTimeout timers — poll instead of a
        // fixed sleep, which flakes on slow CI runners (broke main, see #88)
        await vi.waitFor(() => {
            expect(container.querySelector('.out')?.textContent).toBe('Hello, world');
        }, { timeout: 5000 });
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
        // Page-lifetime cache: the entry persists for later mounts
        expect('restored-stream' in (globalThis as any).__SIGX_ASYNC__).toBe(true);
    });

    it('stops pulling tokens after the component unmounts', async () => {
        let pulls = 0;
        let release!: () => void;
        async function* slowTokens(): AsyncGenerator<string> {
            for (;;) {
                pulls++;
                await new Promise<void>(r => { release = r; });
                yield 't';
            }
        }

        const show = signal({ value: true });
        const App = component(() => {
            const text = useStream('unmount-stream', () => slowTokens());
            return () => <div class="out">{text.value}</div>;
        }, { name: 'App' });
        const Wrapper = component(() => {
            return () => show.value ? jsx(App, {}) : <div class="gone" />;
        }, { name: 'Wrapper' });

        mount(jsx(Wrapper, {}));
        await tick();
        const pullsBeforeUnmount = pulls;

        show.value = false;
        await tick();
        release();          // resolve the pending pull
        await settle();
        release?.();        // and any follow-up
        await settle();

        // The loop broke on unmount: at most one in-flight pull completed,
        // and no NEW pulls were issued afterwards
        expect(pulls).toBeLessThanOrEqual(pullsBeforeUnmount + 1);
    });

    it('throws when called outside component setup', () => {
        expect(() => useStream('k', () => tokens(['x']))).toThrow(/setup/);
    });
});
