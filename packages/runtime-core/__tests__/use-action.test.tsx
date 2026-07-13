/**
 * Tests for useAction() — the manual async write (docs/rfc-async.md rev 8).
 *
 * Covers: idle start, settled RunResult (never rejects), supersede via
 * newer run()/reset()/unmount (SupersededError, no state writes, NO abort),
 * retry-with-last-input, reset(), match dispatch, and the option warning.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, useAction, SupersededError, type AsyncAction } from 'sigx';
import { render } from '@sigx/runtime-dom';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

describe('useAction', () => {
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
        vi.restoreAllMocks();
    });

    function mountAction<T, In>(fn: (input: In, ctx: { signal: AbortSignal }) => Promise<T>): AsyncAction<T, In> {
        let action!: AsyncAction<T, In>;
        const App = component(() => {
            action = useAction(fn);
            return () => <div>{action.state}</div>;
        });
        mount(jsx(App, {}));
        return action;
    }

    it('starts idle and never auto-runs', async () => {
        const fn = vi.fn(async () => 'x');
        const action = mountAction(fn);
        await settle();

        expect(action.state).toBe('idle');
        expect(action.value).toBeNull();
        expect(action.error).toBeNull();
        expect(action.loading).toBe(false);
        expect(fn).not.toHaveBeenCalled();
    });

    it('run(input) goes pending → ready and resolves { ok: true, value }', async () => {
        let resolve!: (v: string) => void;
        const action = mountAction<string, string>((input) => {
            expect(input).toBe('payload');
            return new Promise<string>(r => { resolve = r; });
        });

        const p = action.run('payload');
        await tick();
        expect(action.state).toBe('pending');
        expect(action.loading).toBe(true);

        resolve('result');
        const r = await p;
        expect(r).toEqual({ ok: true, value: 'result' });
        expect(action.state).toBe('ready');
        expect(action.value).toBe('result');
        expect(action.error).toBeNull();
    });

    it('a failing run resolves { ok: false, error } and never rejects; value/error mutually exclusive', async () => {
        let calls = 0;
        const action = mountAction<string, void>(() => {
            calls++;
            return calls === 1 ? Promise.resolve('first') : Promise.reject(new Error('failed'));
        });

        await action.run();
        expect(action.value).toBe('first');

        const r = await action.run();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.message).toBe('failed');
        expect(action.state).toBe('errored');
        expect(action.value).toBeNull();
        expect(action.error?.message).toBe('failed');
    });

    it('coerces non-Error rejections and synchronous throws', async () => {
        const action = mountAction<never, void>(() => { throw 'sync string'; });
        const r = await action.run();
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toBeInstanceOf(Error);
            expect(r.error.message).toBe('sync string');
        }
    });

    it('a newer run supersedes the older: SupersededError result, no state write, NO abort', async () => {
        const resolvers: Array<(v: string) => void> = [];
        const signals: AbortSignal[] = [];
        const action = mountAction<string, void>((_i, { signal: s }) => {
            signals.push(s);
            return new Promise<string>(r => { resolvers.push(r); });
        });

        const p1 = action.run();
        await tick();
        const p2 = action.run();
        await tick();

        // First run's request is NOT aborted (an aborted POST ≠ undone POST)
        expect(signals[0].aborted).toBe(false);

        resolvers[0]('old');
        const r1 = await p1;
        expect(r1.ok).toBe(false);
        if (!r1.ok) {
            expect(r1.error).toBeInstanceOf(SupersededError);
            expect(r1.error.name).toBe('SupersededError');
        }
        // Superseded run wrote nothing — still pending on run 2
        expect(action.state).toBe('pending');
        expect(action.error).toBeNull();

        resolvers[1]('new');
        const r2 = await p2;
        expect(r2).toEqual({ ok: true, value: 'new' });
        expect(action.value).toBe('new');
    });

    it('a superseded FAILING run also resolves SupersededError and never writes .error', async () => {
        const rejecters: Array<(e: Error) => void> = [];
        const resolvers: Array<(v: string) => void> = [];
        const action = mountAction<string, void>(() =>
            new Promise<string>((res, rej) => { resolvers.push(res); rejecters.push(rej); })
        );

        const p1 = action.run();
        await tick();
        void action.run();
        await tick();

        rejecters[0](new Error('old failure'));
        const r1 = await p1;
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.error).toBeInstanceOf(SupersededError);
        expect(action.error).toBeNull();

        resolvers[1]('fine');
        await settle();
        expect(action.value).toBe('fine');
    });

    it('reset() returns to idle, clears value/error, discards in-flight observation without aborting', async () => {
        const resolvers: Array<(v: string) => void> = [];
        const signals: AbortSignal[] = [];
        const action = mountAction<string, void>((_i, { signal: s }) => {
            signals.push(s);
            return new Promise<string>(r => { resolvers.push(r); });
        });

        await (async () => { const p = action.run(); resolvers[0]('done'); await p; })();
        expect(action.state).toBe('ready');

        const p2 = action.run();
        await tick();
        action.reset();

        expect(action.state).toBe('idle');
        expect(action.value).toBeNull();
        expect(action.error).toBeNull();
        expect(signals[1].aborted).toBe(false); // request left running

        resolvers[1]('late');
        const r2 = await p2;
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.error).toBeInstanceOf(SupersededError);
        expect(action.state).toBe('idle'); // no write after reset
    });

    it('the error arm\'s retry re-runs the LAST input; stale is the last success', async () => {
        let calls = 0;
        const inputs: string[] = [];
        let action!: AsyncAction<string, string>;
        let armRetry!: () => void;
        let armStale: string | null = 'unset' as any;

        const App = component(() => {
            action = useAction<string, string>((input) => {
                calls++;
                inputs.push(input);
                return calls === 2 ? Promise.reject(new Error('second fails')) : Promise.resolve(`ok:${input}`);
            });
            return () => (
                <div class="out">
                    {action.match({
                        idle: () => 'IDLE',
                        pending: () => 'PENDING',
                        error: (e, retry, stale) => {
                            armRetry = retry;
                            armStale = stale;
                            return `ERROR:${e.message}`;
                        },
                        ready: (v) => v,
                    })}
                </div>
            );
        });
        const container = mount(jsx(App, {}));
        expect(container.querySelector('.out')?.textContent).toBe('IDLE');

        await action.run('first');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ok:first');

        await action.run('second');
        await settle();
        expect(container.querySelector('.out')?.textContent).toBe('ERROR:second fails');
        expect(armStale).toBe('ok:first'); // last success survives for the arm

        armRetry();
        await settle();
        expect(inputs).toEqual(['first', 'second', 'second']); // retry = last input
        expect(container.querySelector('.out')?.textContent).toBe('ok:second');
    });

    it('zero-arg run() works when In = void', async () => {
        const action = mountAction<number, void>(async () => 7);
        const r = await action.run();
        expect(r).toEqual({ ok: true, value: 7 });
    });

    it('unmount supersedes an in-flight run: SupersededError, no state write, no abort', async () => {
        let resolve!: (v: string) => void;
        let sig!: AbortSignal;
        let action!: AsyncAction<string, void>;
        const show = signal({ value: true });

        const Child = component(() => {
            action = useAction((_i: void, { signal: s }) => {
                sig = s;
                return new Promise<string>(r => { resolve = r; });
            });
            return () => <div />;
        });
        const App = component(() => () => (show.value ? jsx(Child, {}) : null));
        mount(jsx(App, {}));

        const p = action.run();
        await tick();
        show.value = false;
        await settle();

        expect(sig.aborted).toBe(false);
        resolve('late');
        const r = await p;
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBeInstanceOf(SupersededError);
        expect(action.state).toBe('pending'); // frozen — no write after unmount
    });

    it('an action fetcher reading a signal does NOT warn (closures over state are the natural form)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const draft = signal({ name: 'x' });
        const action = mountAction<string, void>(async () => draft.name);
        await action.run();

        expect(warn.mock.calls.some(c => String(c[0]).includes('untracked'))).toBe(false);
    });

    it('warns on unknown option keys (core reads none)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const App = component(() => {
            useAction(async () => 1, { optimistic: true } as any);
            return () => <div />;
        });
        mount(jsx(App, {}));

        expect(warn.mock.calls.some(c => String(c[0]).includes("'optimistic'"))).toBe(true);
    });

    it('throws when called outside component setup', () => {
        expect(() => useAction(async () => 1)).toThrow(/setup/);
    });
});
