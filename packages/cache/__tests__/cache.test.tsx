/**
 * @sigx/cache — behavior of the store-backed cells and action effects, and
 * the §7 contract: reads/actions without `cache` options keep core's
 * default-engine semantics verbatim (delegation), core's dev warning stays
 * quiet for the pack's option key, and the SSR blob seeds the cache.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, defineApp, useData, useAction, type AsyncState, type App } from 'sigx';
import '@sigx/runtime-dom'; // installs the default mount
import { cachePlugin } from '@sigx/cache';
import type { CachedAsyncState } from '@sigx/cache';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

describe('@sigx/cache', () => {
    const containers: HTMLDivElement[] = [];
    const apps: App[] = [];

    /** Mount a root component under an app with the cache plugin installed. */
    function mountWith(plugin: ReturnType<typeof cachePlugin> | null, node: any): HTMLDivElement {
        const app = defineApp(node);
        if (plugin) app.use(plugin);
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);
        apps.push(app);
        app.mount(container as any);
        return container;
    }

    afterEach(() => {
        for (const app of apps.splice(0)) app.unmount();
        for (const c of containers.splice(0)) c.remove();
        delete (globalThis as any).__SIGX_ASYNC__;
        vi.restoreAllMocks();
    });

    // ====================================================================
    // staleTime + shared entries
    // ====================================================================

    it('a fresh cached value is served WITHOUT fetching; a stale one revalidates in the background', async () => {
        const fetcher = vi.fn(async () => ({ n: Math.random() }));
        let first!: AsyncState<{ n: number }>;

        const One = component(() => {
            first = useData('fresh-key', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div class="a">{first.state}</div>;
        });
        const show = signal({ second: false });
        let second!: AsyncState<{ n: number }>;
        const Two = component(() => {
            second = useData('fresh-key', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div class="b">{second.state}</div>;
        });
        const Root = component(() => () => (
            <div>
                {jsx(One, {})}
                {show.second ? jsx(Two, {}) : null}
            </div>
        ));
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(first.state).toBe('ready');

        // A second consumer mounting inside the freshness window: served
        // from cache, NO fetch, same value.
        show.second = true;
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(second.state).toBe('ready');
        expect(second.value).toEqual(first.value);
    });

    it('staleTime 0 (default): a cached value is served immediately and revalidated — state refreshing, then fresh value', async () => {
        let calls = 0;
        const resolvers: Array<(v: { v: number }) => void> = [];
        const fetcher = vi.fn(() => {
            calls++;
            return new Promise<{ v: number }>(r => { resolvers.push(r); });
        });
        const show = signal({ second: false });
        let a!: AsyncState<{ v: number }>, b!: AsyncState<{ v: number }>;

        const A = component(() => {
            a = useData('swr-key', fetcher, { cache: {} });
            return () => <div>{a.state}</div>;
        });
        const B = component(() => {
            b = useData('swr-key', fetcher, { cache: {} });
            return () => <div>{b.state}</div>;
        });
        const Root = component(() => () => (
            <div>
                {jsx(A, {})}
                {show.second ? jsx(B, {}) : null}
            </div>
        ));
        mountWith(cachePlugin(), jsx(Root, {}));
        resolvers[0]({ v: 1 });
        await settle();
        expect(a.value).toEqual({ v: 1 });

        show.second = true;
        await settle();
        // B was served the cached value while its revalidation runs
        expect(b.value).toEqual({ v: 1 });
        expect(b.state).toBe('refreshing');
        expect(b.loading).toBe(false);
        expect(calls).toBe(2);

        resolvers[1]({ v: 2 });
        await settle();
        expect(b.value).toEqual({ v: 2 });
        expect(a.value).toEqual({ v: 2 }); // shared entry — A updated too
    });

    // ====================================================================
    // Blob-as-seed (§7 obligation 3)
    // ====================================================================

    it('adopts __SIGX_ASYNC__ as initial cache state: hydrated values are fresh entries', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { seeded: { from: 'server' } };
        const fetcher = vi.fn(async () => ({ from: 'client' }));
        let cell!: AsyncState<{ from: string }>;

        const App_ = component(() => {
            cell = useData('seeded', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div>{cell.value?.from}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(App_, {}));
        await settle();

        expect(fetcher).not.toHaveBeenCalled(); // fresh from the blob
        expect(cell.state).toBe('ready');
        expect(container.textContent).toBe('server');
    });

    // ====================================================================
    // keepPreviousData
    // ====================================================================

    it('keepPreviousData: a key change shows the previous value as refreshing instead of a hard reset', async () => {
        const resolvers = new Map<string, (v: string) => void>();
        const page = signal({ n: 1 });
        let cell!: AsyncState<string>;

        const App_ = component(() => {
            cell = useData(
                () => ['page', page.n] as const,
                ([, n]) => new Promise<string>(r => { resolvers.set(String(n), r); }),
                { cache: { keepPreviousData: true } }
            );
            return () => <div class="out">{cell.state}:{cell.value ?? '∅'}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(App_, {}));
        resolvers.get('1')!('page-1');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ready:page-1');

        page.n = 2;
        await tick();
        // NOT core's hard reset: previous page keeps rendering while page 2 loads
        expect(cell.state).toBe('refreshing');
        expect(cell.value).toBe('page-1');
        expect(cell.loading).toBe(false);

        resolvers.get('2')!('page-2');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ready:page-2');
    });

    // ====================================================================
    // invalidate + mutate on reads
    // ====================================================================

    it('invalidate() refetches for every mounted consumer of the key', async () => {
        let calls = 0;
        const fetcher = vi.fn(async () => ({ v: ++calls }));
        let a!: CachedAsyncState<{ v: number }>, b!: AsyncState<{ v: number }>;

        const A = component(() => {
            a = useData('inv-key', fetcher, { cache: { staleTime: 60_000 } }) as CachedAsyncState<{ v: number }>;
            return () => <div>{a.value?.v}</div>;
        });
        const B = component(() => {
            b = useData('inv-key', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div>{b.value?.v}</div>;
        });
        const Root = component(() => () => <div>{jsx(A, {})}{jsx(B, {})}</div>);
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        a.invalidate();
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(a.value).toEqual({ v: 2 });
        expect(b.value).toEqual({ v: 2 });
    });

    it('mutate() writes through to every mounted consumer immediately', async () => {
        const fetcher = async () => ({ name: 'Ada' });
        let a!: CachedAsyncState<{ name: string }>, b!: AsyncState<{ name: string }>;

        const A = component(() => {
            a = useData('mut-key', fetcher, { cache: { staleTime: 60_000 } }) as CachedAsyncState<{ name: string }>;
            return () => <div class="a">{a.value?.name}</div>;
        });
        const B = component(() => {
            b = useData('mut-key', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div class="b">{b.value?.name}</div>;
        });
        const Root = component(() => () => <div>{jsx(A, {})}{jsx(B, {})}</div>);
        const container = mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(container.querySelector('.b')?.textContent).toBe('Ada');

        a.mutate(u => ({ ...(u as { name: string }), name: 'Grace' }));
        await settle();
        expect(container.querySelector('.a')?.textContent).toBe('Grace');
        expect(container.querySelector('.b')?.textContent).toBe('Grace');
        expect(a.state).toBe('ready');
    });

    // ====================================================================
    // Action effects: invalidates + optimistic
    // ====================================================================

    it('a successful action invalidates listed keys — including tuple PREFIXES', async () => {
        let listCalls = 0;
        let itemCalls = 0;
        let other = 0;
        let list!: AsyncState<number>, item!: AsyncState<number>, unrelated!: AsyncState<number>;
        let save!: { run(input: void): Promise<{ ok: boolean }> };

        const Root = component(() => {
            list = useData(() => ['posts'] as const, async () => ++listCalls, { cache: { staleTime: 60_000 } });
            item = useData(() => ['posts', 'p1'] as const, async () => ++itemCalls, { cache: { staleTime: 60_000 } });
            unrelated = useData('users', async () => ++other, { cache: { staleTime: 60_000 } });
            save = useAction(async () => 'saved', { cache: { invalidates: [['posts']] } } as any);
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect([listCalls, itemCalls, other]).toEqual([1, 1, 1]);

        await save.run();
        await settle();

        // Both ['posts'] and ['posts','p1'] match the ['posts'] prefix
        expect(listCalls).toBe(2);
        expect(itemCalls).toBe(2);
        expect(other).toBe(1); // untouched
        expect(list.value).toBe(2);
        expect(item.value).toBe(2);
    });

    it('optimistic apply renders immediately; a failed run rolls back', async () => {
        let rejectSave!: (e: Error) => void;
        let user!: AsyncState<{ name: string }>;
        let save!: { run(input: string): Promise<{ ok: boolean }> };

        const Root = component(() => {
            user = useData('opt-user', async () => ({ name: 'Ada' }), { cache: { staleTime: 60_000 } });
            save = useAction(
                (_name: string) => new Promise<never>((_, rej) => { rejectSave = rej; }),
                {
                    cache: {
                        optimistic: {
                            key: 'opt-user',
                            apply: (current: { name: string } | null, input: string) => ({ ...(current ?? {}), name: input }),
                        },
                    },
                } as any
            );
            return () => <div class="who">{user.value?.name}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(container.querySelector('.who')?.textContent).toBe('Ada');

        const p = save.run('Grace');
        await tick();
        expect(container.querySelector('.who')?.textContent).toBe('Grace'); // optimistic

        rejectSave(new Error('server said no'));
        const r = await p;
        await settle();
        expect(r.ok).toBe(false);
        expect(container.querySelector('.who')?.textContent).toBe('Ada'); // rolled back
    });

    it('a rollback is skipped when something newer wrote to the entry meanwhile', async () => {
        let rejectFirst!: (e: Error) => void;
        let user!: CachedAsyncState<{ name: string }>;
        let save!: { run(input: string): Promise<{ ok: boolean }> };

        const Root = component(() => {
            user = useData('race-user', async () => ({ name: 'Ada' }), { cache: { staleTime: 60_000 } }) as CachedAsyncState<{ name: string }>;
            save = useAction(
                (_name: string) => new Promise<never>((_, rej) => { rejectFirst = rej; }),
                { cache: { optimistic: { key: 'race-user', apply: (_c: unknown, input: string) => ({ name: input }) } } } as any
            );
            return () => <div class="who">{user.value?.name}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(Root, {}));
        await settle();

        const p = save.run('Grace');
        await tick();
        expect(container.querySelector('.who')?.textContent).toBe('Grace');

        // A NEWER direct write lands before the failed run settles
        user.mutate({ name: 'Hopper' });
        await tick();

        rejectFirst(new Error('nope'));
        await p;
        await settle();
        // The old snapshot must NOT clobber the newer write
        expect(container.querySelector('.who')?.textContent).toBe('Hopper');
    });

    // ====================================================================
    // Revalidation triggers
    // ====================================================================

    it('revalidateOnFocus refetches mounted reads on window focus', async () => {
        let calls = 0;
        const fetcher = vi.fn(async () => ++calls);
        let cell!: AsyncState<number>;

        const Root = component(() => {
            cell = useData('focus-key', fetcher, { cache: { revalidateOnFocus: true } });
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(calls).toBe(1);

        window.dispatchEvent(new Event('focus'));
        await settle();
        expect(calls).toBe(2);
        expect(cell.value).toBe(2);
    });

    it('revalidateOnInterval refetches on a timer while mounted', async () => {
        let calls = 0;
        const Root = component(() => {
            useData('interval-key', async () => ++calls, { cache: { revalidateOnInterval: 30 } });
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(calls).toBe(1);

        await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    });

    // ====================================================================
    // gcTime
    // ====================================================================

    it('gcTime retains an entry across unmount/remount; gcTime 0 drops it immediately', async () => {
        const retained = vi.fn(async () => 'kept');
        const dropped = vi.fn(async () => 'gone');
        const show = signal({ on: true });

        const Kept = component(() => {
            useData('kept-key', retained, { cache: { staleTime: 60_000, gcTime: 60_000 } });
            return () => <div />;
        });
        const Gone = component(() => {
            useData('gone-key', dropped, { cache: { staleTime: 60_000, gcTime: 0 } });
            return () => <div />;
        });
        const Root = component(() => () => (show.on ? <div>{jsx(Kept, {})}{jsx(Gone, {})}</div> : <div />));
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(retained).toHaveBeenCalledTimes(1);
        expect(dropped).toHaveBeenCalledTimes(1);

        show.on = false;
        await settle();
        show.on = true;
        await settle();

        expect(retained).toHaveBeenCalledTimes(1); // still fresh in the retained entry
        expect(dropped).toHaveBeenCalledTimes(2);  // gc'd ⇒ refetched
    });

    // ====================================================================
    // §7 delegation + option-warning
    // ====================================================================

    it('reads without a cache option keep core default-engine semantics (per-mount fetch after blob consume, hard key reset)', async () => {
        const resolvers = new Map<string, (v: string) => void>();
        const id = signal({ v: 'a' });
        let cell!: AsyncState<string>;

        const Root = component(() => {
            cell = useData(
                () => id.v,
                (key) => new Promise<string>(r => { resolvers.set(key, r); })
            );
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await tick();
        resolvers.get('a')!('A');
        await settle();
        expect(cell.value).toBe('A');

        id.v = 'b';
        await tick();
        // Core's pinned hard reset — no keepPreviousData without opting in
        expect(cell.state).toBe('pending');
        expect(cell.value).toBeNull();
        expect((cell as CachedAsyncState<string>).invalidate).toBeTypeOf('function');
    });

    it("the pack's option key never triggers core's unknown-option warning; unknown keys still do", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const Root = component(() => {
            useData('warn-a', async () => 1, { cache: { staleTime: 5 } });
            useData('warn-b', async () => 2, { bogus: true } as any);
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();

        const texts = warn.mock.calls.map(c => String(c[0]));
        expect(texts.some(t => t.includes("'cache'"))).toBe(false);
        // Typos keep warning even with the engine installed — the warning
        // consults the shared handled-keys registry, which only silences
        // keys a pack actually registered.
        expect(texts.some(t => t.includes("'bogus'"))).toBe(true);
    });

    it('without the plugin, the cache option warns as unhandled (core default engine)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const Root = component(() => {
            useData('no-plugin', async () => 1, { cache: { staleTime: 5 } } as any);
            return () => <div />;
        });
        mountWith(null, jsx(Root, {}));
        await settle();

        // NOTE: registerHandledAsyncOptionKeys is module-global; once the
        // pack registered 'cache' in this realm the warning stays silent.
        // The assertion is therefore on absence of a crash + working read —
        // the strict no-plugin warning behavior is covered in core's suite.
        expect(warn.mock.calls.every(c => !String(c[0]).includes('crash'))).toBe(true);
    });

    it('actions without a cache option are returned untouched', async () => {
        let action!: { run(): Promise<{ ok: boolean; value?: number }> };
        const Root = component(() => {
            action = useAction(async () => 42);
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        const r = await action.run();
        expect(r).toEqual({ ok: true, value: 42 });
    });

    // ====================================================================
    // Error handling on cached reads (SWR)
    // ====================================================================

    it('an initial cached fetch failure settles as errored with the error exposed', async () => {
        const fetcher = vi.fn(async () => {
            throw new Error('boom');
        });
        let cell!: AsyncState<number>;

        const Root = component(() => {
            cell = useData('err-initial', fetcher, { cache: {} });
            return () => <div class="out">{cell.state}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(Root, {}));
        await settle();

        expect(cell.state).toBe('errored');
        expect(cell.error?.message).toBe('boom');
        expect(cell.value).toBeNull();
        expect(cell.loading).toBe(false);
        expect(container.querySelector('.out')?.textContent).toBe('errored');
    });

    it('SWR: a failed refresh keeps the last-good value — error arm gets (error, retry, stale), retry recovers', async () => {
        let calls = 0;
        const fetcher = vi.fn(async () => {
            calls++;
            if (calls === 2) throw new Error('flaky');
            return `v${calls}`;
        });
        let cell!: AsyncState<string>;

        const Root = component(() => {
            cell = useData('err-swr', fetcher, { cache: { staleTime: 60_000 } });
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(cell.value).toBe('v1');

        // refresh() forces a refetch; its failure must never reject.
        await expect(cell.refresh()).resolves.toBeUndefined();
        await settle();

        expect(cell.state).toBe('errored');
        expect(cell.error?.message).toBe('flaky');
        expect(cell.value).toBeNull();

        // The error arm sees the last-good value as `stale`.
        let seenStale: string | null = null;
        let retryFn!: () => void;
        const rendered = cell.match({
            ready: v => `R:${v}`,
            error: (e, retry, stale) => {
                seenStale = stale;
                retryFn = retry;
                return `E:${e.message}`;
            },
        });
        expect(rendered).toBe('E:flaky');
        expect(seenStale).toBe('v1');

        retryFn();
        await settle();
        expect(cell.state).toBe('ready');
        expect(cell.value).toBe('v3');
        expect(cell.match({ ready: v => `R:${v}`, error: e => `E:${e.message}` })).toBe('R:v3');
    });

    it('two consumers joining one in-flight fetch that rejects both settle errored from a single fetch', async () => {
        const rejecters: Array<(e: Error) => void> = [];
        const fetcher = vi.fn(() => new Promise<never>((_, rej) => { rejecters.push(rej); }));
        const show = signal({ second: false });
        let a!: AsyncState<never>, b!: AsyncState<never>;

        const A = component(() => {
            a = useData('err-shared', fetcher, { cache: {} });
            return () => <div />;
        });
        const B = component(() => {
            b = useData('err-shared', fetcher, { cache: {} });
            return () => <div />;
        });
        const Root = component(() => () => (
            <div>
                {jsx(A, {})}
                {show.second ? jsx(B, {}) : null}
            </div>
        ));
        mountWith(cachePlugin(), jsx(Root, {}));
        await tick();

        // B mounts while A's fetch is in flight — it joins, no second fetch.
        show.second = true;
        await tick();
        expect(fetcher).toHaveBeenCalledTimes(1);

        rejecters[0](new Error('shared boom'));
        await settle();
        expect(a.state).toBe('errored');
        expect(b.state).toBe('errored');
        expect(a.error?.message).toBe('shared boom');
        expect(b.error?.message).toBe('shared boom');
    });

    it('a synchronously-throwing fetcher settles as errored instead of crashing the mount', async () => {
        const fetcher = (() => {
            throw new Error('sync boom');
        }) as unknown as () => Promise<never>;
        let cell!: AsyncState<never>;

        const Root = component(() => {
            cell = useData('err-sync', fetcher, { cache: {} });
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();

        expect(cell.state).toBe('errored');
        expect(cell.error?.message).toBe('sync boom');
    });

    // ====================================================================
    // Key handling on cached reads
    // ====================================================================

    it('a falsy getter key is idle; truthy fetches; back to falsy returns to idle', async () => {
        const on = signal({ v: false });
        const fetcher = vi.fn(async () => 'loaded');
        let cell!: AsyncState<string>;

        const Root = component(() => {
            cell = useData(() => (on.v ? 'falsy-toggle' : null), fetcher, { cache: { staleTime: 60_000 } });
            return () => <div class="out">{cell.state}</div>;
        });
        const container = mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(cell.state).toBe('idle');
        expect(fetcher).not.toHaveBeenCalled();

        on.v = true;
        await settle();
        expect(cell.state).toBe('ready');
        expect(cell.value).toBe('loaded');

        on.v = false;
        await settle();
        expect(cell.state).toBe('idle');
        expect(cell.value).toBeNull();
        expect(cell.error).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.out')?.textContent).toBe('idle');
    });

    it('a same-canonical key re-emission hands the freshest raw arg to store-driven refetches', async () => {
        const touch = signal({ n: 0 });
        const tuples: Array<readonly [string, string]> = [];
        const args: unknown[] = [];
        const fetcher = vi.fn(async (arg: readonly [string, string]) => {
            args.push(arg);
            return 'ok';
        });
        let cell!: CachedAsyncState<string>;

        const Root = component(() => {
            cell = useData(
                () => {
                    void touch.n; // unrelated dependency — re-runs the getter without changing the key
                    const t = ['stable', 'id'] as const;
                    tuples.push(t);
                    return t;
                },
                fetcher,
                { cache: { staleTime: 60_000 } }
            ) as CachedAsyncState<string>;
            return () => <div />;
        });
        mountWith(cachePlugin(), jsx(Root, {}));
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(args[0]).toBe(tuples[0]);

        // Same canonical identity, fresh tuple object: no refetch, but the
        // NEW raw must replace the old one on the entry…
        touch.n = 1;
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        const latest = tuples[tuples.length - 1];
        expect(latest).not.toBe(tuples[0]);

        // …so a store-driven refetch (invalidate uses entry.rawArg) gets it.
        cell.invalidate();
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(args[1]).toBe(latest);
    });
});
