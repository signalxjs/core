/**
 * Tests for useData() — default client semantics of the value-first async
 * read (docs/rfc-async.md rev 8).
 *
 * Covers: state machine (pending → ready/errored, refreshing), match
 * dispatch (idle default, stale error param, unhandled bubble), reactive
 * string/tuple keys (canonical identity, hard reset, supersede), dev
 * guards, restoration from __SIGX_ASYNC__, refcounted in-flight dedupe
 * (shared fetch survives one unmount; sole-consumer unmount aborts), and
 * option-bag warnings.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, useData, type AsyncState } from 'sigx';
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

describe('useData', () => {
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
        // Consume-once blob is global: reset between tests
        delete (globalThis as any).__SIGX_ASYNC__;
        vi.restoreAllMocks();
    });

    // ========================================================================
    // State machine: pending → ready
    // ========================================================================

    it('goes pending → ready; loading is true only while pending', async () => {
        let resolve!: (val: string) => void;
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData('greeting', () => new Promise<string>(r => { resolve = r; }));
            return () =>
                cell.loading
                    ? <div class="loading">Loading</div>
                    : <div class="content">{cell.value}</div>;
        }, { name: 'App' });

        const container = mount(jsx(App, {}));

        expect(cell.state).toBe('pending');
        expect(cell.loading).toBe(true);
        expect(cell.value).toBeNull();
        expect(container.querySelector('.loading')).toBeTruthy();

        resolve('hello world');
        await settle();

        expect(cell.state).toBe('ready');
        expect(cell.loading).toBe(false);
        expect(container.querySelector('.content')?.textContent).toBe('hello world');
    });

    it('the fetcher receives the key as its first argument', async () => {
        const fetcher = vi.fn(async (key: string) => `got:${key}`);
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData('the-key', fetcher);
            return () => <div>{cell.value}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe('the-key');
        expect((fetcher.mock.calls[0] as any)[1]).toHaveProperty('signal');
        expect(cell.value).toBe('got:the-key');
    });

    // ========================================================================
    // Errors: normalized, mutually exclusive with value
    // ========================================================================

    it('captures fetch errors: state errored, value null, error set', async () => {
        let reject!: (err: unknown) => void;
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData('err', () => new Promise<string>((_, r) => { reject = r; }));
            return () => <div>{cell.state}</div>;
        });
        const container = mount(jsx(App, {}));

        reject(new Error('boom'));
        await settle();

        expect(cell.state).toBe('errored');
        expect(cell.error?.message).toBe('boom');
        expect(cell.value).toBeNull();
        expect(cell.loading).toBe(false);
        expect(container.textContent).toBe('errored');
    });

    it('coerces non-Error rejections to Error', async () => {
        let cell!: AsyncState<never>;
        const App = component(() => {
            cell = useData('err2', () => Promise.reject('plain string'));
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        expect(cell.error).toBeInstanceOf(Error);
        expect(cell.error?.message).toBe('plain string');
    });

    it('a synchronously-throwing fetcher lands on .error (no unhandled throw)', async () => {
        let cell!: AsyncState<never>;
        const App = component(() => {
            cell = useData('sync-throw', () => { throw new Error('sync'); });
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        expect(cell.state).toBe('errored');
        expect(cell.error?.message).toBe('sync');
    });

    // ========================================================================
    // match() dispatch
    // ========================================================================

    it('match renders the arm for each state; idle defaults to the pending arm', async () => {
        const on = signal({ key: null as string | null });
        let resolve!: (v: string) => void;

        const App = component(() => {
            const cell = useData(
                () => on.key,
                () => new Promise<string>(r => { resolve = r; })
            );
            return () => (
                <div class="out">
                    {cell.match({
                        pending: () => 'PENDING',
                        ready: (v) => `READY:${v}`,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));

        // idle with no idle arm ⇒ pending arm
        expect(container.querySelector('.out')?.textContent).toBe('PENDING');

        on.key = 'k';
        await tick();
        expect(container.querySelector('.out')?.textContent).toBe('PENDING');

        resolve('v');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('READY:v');
    });

    it('match renders a dedicated idle arm when given; omitted pending renders nothing', async () => {
        const App = component(() => {
            const cell = useData(() => null, async () => 'never');
            return () => (
                <div class="out">
                    {cell.match({
                        idle: () => 'IDLE',
                        ready: (v) => v,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        expect(container.querySelector('.out')?.textContent).toBe('IDLE');

        const App2 = component(() => {
            const cell = useData('never-resolves', () => new Promise<string>(() => { }));
            return () => (
                <div class="out2">
                    {cell.match({ ready: (v) => v }) ?? null}
                </div>
            );
        });
        const c2 = mount(jsx(App2, {}));
        expect(c2.querySelector('.out2')?.textContent).toBe('');
    });

    it('error arm receives (error, retry, stale); retry refetches', async () => {
        let calls = 0;
        let cell!: AsyncState<string>;
        const fetcher = () => {
            calls++;
            return calls === 1 ? Promise.reject(new Error('first fails')) : Promise.resolve('second works');
        };

        let seen: { e: Error; retry: () => void; stale: string | null } | null = null;
        const App = component(() => {
            cell = useData('retry-key', fetcher);
            return () => (
                <div class="out">
                    {cell.match({
                        pending: () => 'PENDING',
                        error: (e, retry, stale) => {
                            seen = { e, retry, stale };
                            return `ERROR:${e.message}`;
                        },
                        ready: (v) => `READY:${v}`,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.out')?.textContent).toBe('ERROR:first fails');
        expect(seen!.stale).toBeNull(); // no last-good yet

        seen!.retry();
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('READY:second works');
        expect(calls).toBe(2);
    });

    it('a failed refresh keeps the last-good value as the error arm\'s stale param', async () => {
        let calls = 0;
        let cell!: AsyncState<string>;
        const fetcher = () => {
            calls++;
            return calls === 1 ? Promise.resolve('good') : Promise.reject(new Error('refresh failed'));
        };

        let staleSeen: string | null = null;
        const App = component(() => {
            cell = useData('stale-key', fetcher);
            return () => (
                <div class="out">
                    {cell.match({
                        pending: () => 'PENDING',
                        error: (e, _retry, stale) => {
                            staleSeen = stale;
                            return `ERROR(stale=${stale})`;
                        },
                        ready: (v) => v,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('good');

        await cell.refresh();
        await settle();

        // Top-level value/error stay mutually exclusive…
        expect(cell.value).toBeNull();
        expect(cell.error?.message).toBe('refresh failed');
        // …but the error arm got the last-good value
        expect(container.querySelector('.out')?.textContent).toBe('ERROR(stale=good)');
        expect(staleSeen).toBe('good');
    });

    // ========================================================================
    // Refresh: refreshing state, SWR, never rejects
    // ========================================================================

    it('refresh() on a ready cell keeps the value (state refreshing, loading false)', async () => {
        let resolvers: Array<(v: string) => void> = [];
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData('swr', () => new Promise<string>(r => { resolvers.push(r); }));
            return () => <div class="out">{cell.state}:{cell.value}</div>;
        });
        const container = mount(jsx(App, {}));
        resolvers[0]('v1');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ready:v1');

        const p = cell.refresh();
        await tick();
        expect(cell.state).toBe('refreshing');
        expect(cell.value).toBe('v1');     // SWR: kept during refresh
        expect(cell.loading).toBe(false);  // pending-only

        resolvers[1]('v2');
        await p;
        await settle();
        expect(cell.state).toBe('ready');
        expect(cell.value).toBe('v2');
    });

    it('refresh() never rejects, even when the fetcher fails', async () => {
        let cell!: AsyncState<string>;
        let calls = 0;
        const App = component(() => {
            cell = useData('never-rejects', () => {
                calls++;
                return calls === 1 ? Promise.resolve('ok') : Promise.reject(new Error('nope'));
            });
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        await expect(cell.refresh()).resolves.toBeUndefined();
        expect(cell.error?.message).toBe('nope');
    });

    // ========================================================================
    // Reactive keys: hard reset, supersede, canonical tuple identity
    // ========================================================================

    it('key change clears the value immediately (hard reset ⇒ pending) and the superseded run never writes', async () => {
        const resolvers = new Map<string, (v: string) => void>();
        const id = signal({ value: 'a' });
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData(
                () => ['item', id.value] as const,
                ([, key]) => new Promise<string>(r => { resolvers.set(key, r); })
            );
            return () => <div class="out">{cell.state}:{cell.value ?? '∅'}</div>;
        });
        const container = mount(jsx(App, {}));
        resolvers.get('a')!('value-A');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ready:value-A');

        id.value = 'b';
        await tick();
        // Hard reset: no wrong-data flash
        expect(cell.state).toBe('pending');
        expect(cell.value).toBeNull();

        // The OLD run resolving late must not write anything
        resolvers.get('a')!('late-A');
        await settle();
        expect(cell.state).toBe('pending');
        expect(cell.value).toBeNull();

        resolvers.get('b')!('value-B');
        await settle();
        expect(cell.state).toBe('ready');
        expect(cell.value).toBe('value-B');
    });

    it('a superseded failing run never writes .error', async () => {
        const rejecters = new Map<string, (e: Error) => void>();
        const resolvers = new Map<string, (v: string) => void>();
        const id = signal({ value: 'a' });
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData(
                () => id.value,
                (key) => new Promise<string>((res, rej) => {
                    resolvers.set(key, res);
                    rejecters.set(key, rej);
                })
            );
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));
        await tick();

        id.value = 'b';
        await tick();
        rejecters.get('a')!(new Error('old failure'));
        await settle();
        expect(cell.error).toBeNull();

        resolvers.get('b')!('fresh');
        await settle();
        expect(cell.value).toBe('fresh');
        expect(cell.error).toBeNull();
    });

    it('tuple keys have canonical identity: equal-content fresh tuples do not refetch', async () => {
        const fetcher = vi.fn(async () => 'v');
        const bump = signal({ n: 0 });

        const App = component(() => {
            const cell = useData(
                // A FRESH tuple object every run — same content, and an
                // unrelated signal read forces the key source to re-run.
                () => (void bump.n, ['stable', 1] as const),
                fetcher
            );
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        bump.n++;
        await settle();
        bump.n++;
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1); // canonical string dedupes
    });

    it('two components with equal-content tuple keys share ONE in-flight fetch', async () => {
        let calls = 0;
        let resolve!: (v: string) => void;
        const fetcher = () => {
            calls++;
            return new Promise<string>(r => { resolve = r; });
        };
        const cells: AsyncState<string>[] = [];

        const Child = component(() => {
            cells.push(useData(() => ['shared', 7] as const, fetcher));
            return () => <div />;
        });
        const App = component(() => () => <div>{jsx(Child, {})}{jsx(Child, {})}</div>);
        mount(jsx(App, {}));
        await tick();

        expect(calls).toBe(1);
        resolve('shared-value');
        await settle();
        expect(cells[0].value).toBe('shared-value');
        expect(cells[1].value).toBe('shared-value');
    });

    it('falsy getter ⇒ idle (fetcher never runs); truthy ⇒ fetch; back to falsy ⇒ idle again', async () => {
        const fetcher = vi.fn(async (k: string) => `v:${k}`);
        const key = signal({ value: null as string | null });
        let cell!: AsyncState<string>;

        const App = component(() => {
            cell = useData(() => key.value, fetcher);
            return () => <div>{cell.state}</div>;
        });
        mount(jsx(App, {}));

        expect(cell.state).toBe('idle');
        expect(fetcher).not.toHaveBeenCalled();

        key.value = 'now';
        await settle();
        expect(cell.state).toBe('ready');
        expect(cell.value).toBe('v:now');

        key.value = null;
        await tick();
        expect(cell.state).toBe('idle');
        expect(cell.value).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);

        // refresh() on idle is a resolved no-op
        await expect(cell.refresh()).resolves.toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // ========================================================================
    // Dev guards
    // ========================================================================

    it('rejects the static-tuple form with a pointer to the getter form', () => {
        const App = component(() => {
            useData(['user', 1] as any, async () => 1);
            return () => <div />;
        });
        expect(() => mount(jsx(App, {}))).toThrow(/getter/);
    });

    it('empty tuple and empty string keys skip with a dev warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const fetcher = vi.fn(async () => 1);
        let a!: AsyncState<number>, b!: AsyncState<number>;

        const App = component(() => {
            a = useData(() => [] as const, fetcher);
            b = useData(() => '', fetcher);
            return () => <div />;
        });
        mount(jsx(App, {}));
        await tick();

        expect(a.state).toBe('idle');
        expect(b.state).toBe('idle');
        expect(fetcher).not.toHaveBeenCalled();
        const messages = warn.mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('empty tuple'))).toBe(true);
        expect(messages.some(m => m.includes('empty string'))).toBe(true);
    });

    it('throws in dev on non-finite tuple elements (NaN identity collision)', () => {
        const App = component(() => {
            useData(() => ['x', NaN] as const, async () => 1);
            return () => <div />;
        });
        expect(() => mount(jsx(App, {}))).toThrow(/non-finite/);
    });

    it('warns when the fetcher synchronously reads a signal (fetchers are untracked) — and never refetches from it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const leak = signal({ n: 1 });
        const fetcher = vi.fn(async () => leak.n);
        let cell!: AsyncState<number>;

        const App = component(() => {
            cell = useData('leaky', fetcher);
            return () => <div>{cell.value}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        expect(warn.mock.calls.some(c => String(c[0]).includes('untracked'))).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);

        // The untrack regression: mutating the leaked signal must NOT re-run
        // the fetch (no hidden subscription through the engine).
        leak.n = 2;
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('warns once about unknown option keys; `server` never warns', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const App = component(() => {
            useData('opt-a', async () => 1, { staleTime: 5 } as any);
            useData('opt-b', async () => 2, { staleTime: 5, server: false } as any);
            return () => <div />;
        });
        mount(jsx(App, {}));

        const unknown = warn.mock.calls.filter(c => String(c[0]).includes("'staleTime'"));
        expect(unknown).toHaveLength(1); // deduped across calls
        expect(warn.mock.calls.some(c => String(c[0]).includes("'server'"))).toBe(false);
    });

    // ========================================================================
    // Restore from __SIGX_ASYNC__ (page data cache)
    // ========================================================================

    it('restores from the blob as state ready, without fetching; two components share the entry', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { restored: { n: 42 } };
        const fetcher = vi.fn(async () => ({ n: -1 }));
        const cells: AsyncState<{ n: number }>[] = [];

        const Child = component(() => {
            cells.push(useData('restored', fetcher));
            return () => <div />;
        });
        mount(jsx(component(() => () => <div>{jsx(Child, {})}{jsx(Child, {})}</div>), {}));
        await settle();

        expect(fetcher).not.toHaveBeenCalled();
        expect(cells[0].state).toBe('ready');
        expect(cells[0].value).toEqual({ n: 42 });
        expect(cells[1].value).toEqual({ n: 42 });
    });

    it('a tuple key restores under its canonical JSON blob key', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { '["posts","u1",2]': ['p'] };
        const fetcher = vi.fn(async () => ['fresh']);
        let cell!: AsyncState<string[]>;

        const App = component(() => {
            cell = useData(() => ['posts', 'u1', 2] as const, fetcher);
            return () => <div />;
        });
        mount(jsx(App, {}));
        await tick();

        expect(fetcher).not.toHaveBeenCalled();
        expect(cell.state).toBe('ready');
        expect(cell.value).toEqual(['p']);
    });

    it('refresh() invalidates the blob entry and repopulates it on success', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { cachekey: 'stale' };
        let cell!: AsyncState<string>;
        const App = component(() => {
            cell = useData('cachekey', async () => 'fresh');
            return () => <div />;
        });
        mount(jsx(App, {}));
        await tick();
        expect(cell.value).toBe('stale');

        const p = cell.refresh();
        expect('cachekey' in (globalThis as any).__SIGX_ASYNC__).toBe(false); // invalidated
        expect(cell.state).toBe('refreshing');
        await p;
        await settle();

        expect(cell.value).toBe('fresh');
        expect((globalThis as any).__SIGX_ASYNC__.cachekey).toBe('fresh'); // written back
    });

    // ========================================================================
    // Dedupe races + abort semantics
    // ========================================================================

    it('a stale settle does not evict a newer refresh\'s in-flight entry (dedupe race)', async () => {
        const resolvers: Array<(v: string) => void> = [];
        let calls = 0;
        const fetcher = () => {
            calls++;
            return new Promise<string>(r => { resolvers.push(r); });
        };
        let a!: AsyncState<string>;

        const A = component(() => {
            a = useData('race', fetcher);
            return () => <div />;
        });
        mount(jsx(A, {}));
        await tick();
        expect(calls).toBe(1);

        // Force a refresh while run 1 is still in flight → run 2
        void a.refresh();
        await tick();
        expect(calls).toBe(2);

        // Run 1 settles LATE — must not evict run 2's entry: a third
        // consumer mounting now must JOIN run 2, not start run 3.
        resolvers[0]('old');
        await settle();

        let b!: AsyncState<string>;
        const B = component(() => {
            b = useData('race', fetcher);
            return () => <div />;
        });
        mount(jsx(B, {}));
        await tick();
        expect(calls).toBe(2); // joined, no third fetch

        resolvers[1]('new');
        await settle();
        expect(a.value).toBe('new');
        expect(b.value).toBe('new');
    });

    it('unmounting one of two consumers does NOT abort the shared fetch', async () => {
        let signalSeen!: AbortSignal;
        let resolve!: (v: string) => void;
        const fetcher = (_k: string, { signal: s }: { signal: AbortSignal }) => {
            signalSeen = s;
            return new Promise<string>(r => { resolve = r; });
        };

        const showFirst = signal({ value: true });
        let kept!: AsyncState<string>;

        const First = component(() => {
            useData('shared-abort', fetcher);
            return () => <div class="first" />;
        });
        const Second = component(() => {
            kept = useData('shared-abort', fetcher);
            return () => <div class="second" />;
        });
        const App = component(() => () => (
            <div>
                {showFirst.value ? jsx(First, {}) : null}
                {jsx(Second, {})}
            </div>
        ));
        mount(jsx(App, {}));
        await tick();

        showFirst.value = false;
        await settle();
        expect(signalSeen.aborted).toBe(false); // still one consumer

        resolve('done');
        await settle();
        expect(kept.value).toBe('done');
    });

    it('unmounting the SOLE consumer aborts the in-flight fetch', async () => {
        let signalSeen!: AbortSignal;
        const fetcher = (_k: string, { signal: s }: { signal: AbortSignal }) => {
            signalSeen = s;
            return new Promise<string>(() => { });
        };

        const show = signal({ value: true });
        const Only = component(() => {
            useData('solo-abort', fetcher);
            return () => <div />;
        });
        const App = component(() => () => (show.value ? jsx(Only, {}) : <div class="gone" />));
        mount(jsx(App, {}));
        await tick();
        expect(signalSeen.aborted).toBe(false);

        show.value = false;
        await settle();
        expect(signalSeen.aborted).toBe(true);
    });

    it('unmount before resolve: the late settle writes no state and throws nothing', async () => {
        let resolve!: (v: string) => void;
        let cell!: AsyncState<string>;
        const show = signal({ value: true });

        const Child = component(() => {
            cell = useData('late', () => new Promise<string>(r => { resolve = r; }));
            return () => <div />;
        });
        const App = component(() => () => (show.value ? jsx(Child, {}) : null));
        mount(jsx(App, {}));
        await tick();

        show.value = false;
        await settle();
        resolve('too late');
        await settle();

        expect(cell.state).toBe('pending'); // frozen where it was — no write
        expect(cell.value).toBeNull();
    });

    // ========================================================================
    // Unhandled-error bubble (match without an error arm)
    // ========================================================================

    it('errored + no error arm ⇒ match returns undefined, bubbles once per error, dev-warns once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const error = vi.spyOn(console, 'error').mockImplementation(() => { });

        const rerender = signal({ n: 0 });
        const App = component(() => {
            const cell = useData('bubble', () => Promise.reject(new Error('unhandled!')));
            return () => (
                <div class="out">
                    {void rerender.n}
                    {cell.match({ pending: () => 'P', ready: (v) => String(v) }) ?? 'NOTHING'}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.out')?.textContent).toContain('NOTHING');
        // No errorScope, no app context ⇒ the bubble's last stop logs it
        const bubbled = () => error.mock.calls.filter(c => String(c[0]).includes('Unhandled async error')).length;
        expect(bubbled()).toBe(1);

        // Re-render with the SAME error instance: no re-report, one warning total
        rerender.n++;
        await settle();
        rerender.n++;
        await settle();
        expect(bubbled()).toBe(1);
        expect(warn.mock.calls.filter(c => String(c[0]).includes('no `error` arm')).length).toBe(1);
    });

    // ========================================================================
    // Guards
    // ========================================================================

    it('throws when called outside component setup', () => {
        expect(() => useData('k', async () => 1)).toThrow(/setup/);
    });

    it('supports multiple independent cells in one component', async () => {
        let a!: AsyncState<string>, b!: AsyncState<string>;
        const App = component(() => {
            a = useData('multi-a', async () => 'A');
            b = useData('multi-b', async () => 'B');
            return () => <div>{a.value}{b.value}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.textContent).toBe('AB');
    });
});
