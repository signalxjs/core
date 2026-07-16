/**
 * Coexistence regression (issue #189): the __SIGX_ASYNC__ blob is SHARED by
 * multiple producers — keyed useData reads and e.g. @sigx/store's ssrState()
 * slices — under disjoint key namespaces. useData must restore/invalidate/
 * write back ONLY its own keys and leave foreign entries untouched. (The
 * store package lives in a separate repo; a foreign producer is simulated by
 * seeding its keys directly.)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx, useData, type AsyncState } from 'sigx';
import { render } from '@sigx/runtime-dom';

async function settle(): Promise<void> {
    await new Promise<void>(r => queueMicrotask(r));
    await new Promise(r => setTimeout(r, 10));
}

describe('__SIGX_ASYNC__ coexistence with foreign producers', () => {
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

    it('restores its own key, leaves foreign entries untouched through refresh/writeback', async () => {
        (globalThis as any).__SIGX_ASYNC__ = Object.assign(Object.create(null), {
            'store:cart': { items: 3 },      // foreign producer (store slice)
            user: { name: 'Ada' },           // ours
        });
        const fetcher = vi.fn(async () => ({ name: 'Fresh' }));
        let cell!: AsyncState<{ name: string }>;

        const App = component(() => {
            cell = useData('user', fetcher);
            return () => <div>{cell.value?.name}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        // Restored ours without fetching; foreign key untouched
        expect(fetcher).not.toHaveBeenCalled();
        expect(cell.value).toEqual({ name: 'Ada' });
        expect((globalThis as any).__SIGX_ASYNC__['store:cart']).toEqual({ items: 3 });

        // refresh() invalidates and writes back ONLY our key
        await cell.refresh();
        await settle();
        expect(cell.value).toEqual({ name: 'Fresh' });
        expect((globalThis as any).__SIGX_ASYNC__.user).toEqual({ name: 'Fresh' });
        expect((globalThis as any).__SIGX_ASYNC__['store:cart']).toEqual({ items: 3 });
    });

    it('tuple keys live under canonical JSON — structurally disjoint from store slice keys', async () => {
        (globalThis as any).__SIGX_ASYNC__ = Object.assign(Object.create(null), {
            posts: 'a-store-slice-that-happens-to-be-named-posts',
        });
        const fetcher = vi.fn(async () => ['p1']);
        let cell!: AsyncState<string[]>;

        const App = component(() => {
            // Canonicalizes to '["posts","u1"]' — starts with '[', can never
            // collide with a plain store slice key like 'posts'.
            cell = useData(() => ['posts', 'u1'] as const, fetcher);
            return () => <div />;
        });
        mount(jsx(App, {}));
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(1); // no false restore from 'posts'
        expect(cell.value).toEqual(['p1']);
        expect((globalThis as any).__SIGX_ASYNC__['["posts","u1"]']).toEqual(['p1']);
        expect((globalThis as any).__SIGX_ASYNC__.posts).toBe('a-store-slice-that-happens-to-be-named-posts');
    });
});
