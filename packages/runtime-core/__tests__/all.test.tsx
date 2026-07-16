/**
 * Tests for all() — the AsyncState combinator for all-or-nothing gating
 * (docs/rfc-async.md rev 8 derived-state rules).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { component, signal, jsx, useData, all, type AsyncState, type AllState } from 'sigx';
import { render } from '@sigx/runtime-dom';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

describe('all', () => {
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

    /** Mount two deferred cells + their combination in one component. */
    function setup() {
        const resolvers: Record<string, (v: string) => void> = {};
        const rejecters: Record<string, (e: Error) => void> = {};
        let user!: AsyncState<string>, posts!: AsyncState<string>;
        let combined!: AllState<
            { user: string; posts: string },
            { user: Error | null; posts: Error | null }
        >;

        const App = component(() => {
            const make = (key: string) =>
                useData(key, () => new Promise<string>((res, rej) => {
                    resolvers[key] = res;
                    rejecters[key] = rej;
                }));
            user = make('user');
            posts = make('posts');
            combined = all({ user, posts });
            return () => <div class="out">{combined.state}</div>;
        });
        const container = mount(jsx(App, {}));
        return { resolvers, rejecters, get user() { return user; }, get posts() { return posts; }, get combined() { return combined; }, container };
    }

    it('object form: pending until ALL settle; combined value is a named record', async () => {
        const t = setup();
        expect(t.combined.state).toBe('pending');
        expect(t.combined.loading).toBe(true);
        expect(t.combined.value).toBeNull();

        t.resolvers.user('U');
        await settle();
        expect(t.combined.state).toBe('pending'); // posts still in flight
        expect(t.combined.value).toBeNull();

        t.resolvers.posts('P');
        await settle();
        expect(t.combined.state).toBe('ready');
        expect(t.combined.value).toEqual({ user: 'U', posts: 'P' });
        expect(t.container.querySelector('.out')?.textContent).toBe('ready');
    });

    it('tuple form: positional value and errors', async () => {
        let a!: AsyncState<number>, b!: AsyncState<string>;
        let pair!: AsyncState<readonly [number, string]> & { errors: readonly [Error | null, Error | null] };
        const App = component(() => {
            a = useData('t-a', async () => 1);
            b = useData('t-b', async () => 'two');
            pair = all(a, b) as any;
            return () => <div>{pair.state}</div>;
        });
        mount(jsx(App, {}));
        await settle();

        expect(pair.state).toBe('ready');
        expect(pair.value).toEqual([1, 'two']);
        expect(pair.errors).toEqual([null, null]);
    });

    it('first-error-wins .error; .errors collects all; combined state errored', async () => {
        const t = setup();
        t.rejecters.user(new Error('user failed'));
        t.rejecters.posts(new Error('posts failed'));
        await settle();

        expect(t.combined.state).toBe('errored');
        expect(t.combined.error?.message).toBe('user failed'); // input order
        expect(t.combined.errors).toEqual({
            user: t.user.error,
            posts: t.posts.error,
        });
        expect((t.combined.errors as any).posts?.message).toBe('posts failed');
    });

    it('an idle member holds the combination at idle', async () => {
        const key = signal({ value: null as string | null });
        let combined!: AsyncState<unknown>;
        const App = component(() => {
            const ready = useData('idle-a', async () => 'A');
            const conditional = useData(() => key.value, async (k) => k);
            combined = all({ ready, conditional });
            return () => <div class="out">{combined.state}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.out')?.textContent).toBe('idle');

        key.value = 'now';
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ready');
    });

    it('a refreshing member (all values present) ⇒ combined refreshing, ready arm keeps rendering', async () => {
        const t = setup();
        t.resolvers.user('U');
        t.resolvers.posts('P');
        await settle();
        expect(t.combined.state).toBe('ready');

        void t.user.refresh();
        await tick();
        expect(t.user.state).toBe('refreshing');
        expect(t.combined.state).toBe('refreshing');
        expect(t.combined.loading).toBe(false);
        // match keeps rendering the ready arm with the (kept) values
        const rendered = t.combined.match({
            pending: () => 'PENDING',
            ready: (v) => `READY:${JSON.stringify(v)}`,
        });
        expect(rendered).toBe('READY:{"user":"U","posts":"P"}');

        t.resolvers.user('U2');
        await settle();
        expect(t.combined.state).toBe('ready');
        expect(t.combined.value).toEqual({ user: 'U2', posts: 'P' });
    });

    it('combined refresh() refreshes every member in parallel and never rejects', async () => {
        let userCalls = 0;
        let postsCalls = 0;
        let combined!: AsyncState<unknown>;
        const App = component(() => {
            const user = useData('r-user', () => {
                userCalls++;
                return userCalls === 1 ? Promise.resolve('u') : Promise.reject(new Error('boom'));
            });
            const posts = useData('r-posts', async () => {
                postsCalls++;
                return 'p';
            });
            combined = all({ user, posts });
            return () => <div />;
        });
        mount(jsx(App, {}));
        await settle();

        await expect(combined.refresh()).resolves.toBeUndefined();
        await settle();
        expect(userCalls).toBe(2);
        expect(postsCalls).toBe(2);
        expect(combined.state).toBe('errored'); // user's refresh failed softly
    });

    it('a component reading the combined state re-renders when a member transitions', async () => {
        const t = setup();
        expect(t.container.querySelector('.out')?.textContent).toBe('pending');
        t.resolvers.user('U');
        t.resolvers.posts('P');
        await settle();
        expect(t.container.querySelector('.out')?.textContent).toBe('ready');
    });

    it('match error arm on the combination receives a retry that refreshes all members', async () => {
        const calls: string[] = [];
        let combined!: AsyncState<unknown>;
        let first = true;
        const App = component(() => {
            const a = useData('m-a', () => {
                calls.push('a');
                if (first) return Promise.reject(new Error('a failed'));
                return Promise.resolve('A');
            });
            const b = useData('m-b', async () => {
                calls.push('b');
                return 'B';
            });
            combined = all({ a, b });
            return () => (
                <div class="out">
                    {combined.match({
                        pending: () => 'PENDING',
                        error: (e, retry) => {
                            (globalThis as any).__retryAll = retry;
                            return `ERROR:${e.message}`;
                        },
                        ready: (v) => `READY:${JSON.stringify(v)}`,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ERROR:a failed');

        first = false;
        (globalThis as any).__retryAll();
        await settle();
        expect(calls).toEqual(['a', 'b', 'a', 'b']);
        expect(container.querySelector('.out')?.textContent).toBe('READY:{"a":"A","b":"B"}');
        delete (globalThis as any).__retryAll;
    });
});
