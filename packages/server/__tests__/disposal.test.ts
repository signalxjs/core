/**
 * @vitest-environment node
 *
 * Request-value disposal (rfc-server-v3 §2.6, phase 5, #571): `perRequest`'s
 * `onDispose`, `disposeRequestValues`, claim-based ownership, the scope's
 * `keepAlive`, and the endpoint's settle wiring — including the two pins the
 * RFC names: a `timeoutMs` 504 does not dispose ahead of the settling
 * handler, and every stream terminal disposes AFTER the generator's
 * `finally`.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    serverFn,
    serverStream,
    perRequest,
    disposeRequestValues,
    ServerFnError
} from '../src/index';
import { handleServerFnRequest, type ServerFnRequestOptions } from '../src/server/index';
import { runInScope } from '../src/scope';
import { createDetachedContext } from '../src/context';
import type { ServerFnContext } from '../src/context';
import { stubServerApp } from '../src/testing';

const ORIGIN = 'http://localhost';

// The pipeline is fail-closed (rfc-server-v4 §2.1): stub an authenticated
// app so disposal timing stays the subject.
let restoreApp: () => void;
beforeEach(() => {
    restoreApp = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
});

afterEach(() => {
    restoreApp();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Poll until `check` holds — disposal is deliberately fire-and-forget. */
const eventually = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !check(); i++) await tick();
    expect(check()).toBe(true);
};

const post = (
    fn: unknown,
    options: Partial<ServerFnRequestOptions> = {},
    body = '{"args":[]}',
    headers: Record<string, string> = {}
): Promise<Response> =>
    handleServerFnRequest(
        new Request(`${ORIGIN}/_sigx/fn/d_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
            body
        }),
        { resolve: () => fn, ...options }
    );

/* ------------------------------------------------------------------ */
/* disposeRequestValues — the drain itself                            */
/* ------------------------------------------------------------------ */

describe('disposeRequestValues', () => {
    it('runs disposers LIFO, awaits async ones, and a throw does not stop the rest', async () => {
        const order: string[] = [];
        const first = perRequest((_rq, onDispose) => {
            onDispose(async () => {
                await tick();
                order.push('first');
            });
            return 'a';
        });
        const second = perRequest((_rq, onDispose) => {
            onDispose(() => {
                order.push('second-throws');
                throw new Error('teardown failed');
            });
            return 'b';
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createDetachedContext();
        first(ctx);
        second(ctx);
        await disposeRequestValues(ctx);
        expect(order).toEqual(['second-throws', 'first']); // LIFO, throw swallowed
        expect(warn.mock.calls.some(([m]) => String(m).includes('disposer threw'))).toBe(true);
    });

    it('is idempotent — a second call runs nothing again', async () => {
        let runs = 0;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void runs++);
            return 1;
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createDetachedContext();
        value(ctx);
        await disposeRequestValues(ctx);
        await disposeRequestValues(ctx);
        expect(runs).toBe(1);
    });

    it('clears the memo — a reused store recomputes its setups', async () => {
        let computed = 0;
        const value = perRequest(() => ++computed);
        const ctx = createDetachedContext();
        expect(value(ctx)).toBe(1);
        expect(value(ctx)).toBe(1);
        await disposeRequestValues(ctx);
        expect(value(ctx)).toBe(2);
    });

    it('a disposer-less disposal still marks the store — a late onDispose runs immediately', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createDetachedContext();
        const plain = perRequest(() => 'no disposer');
        plain(ctx);
        await disposeRequestValues(ctx); // nothing registered — must still mark disposed
        let lateRan = false;
        const late = perRequest((_rq, onDispose) => {
            onDispose(() => void (lateRan = true));
            return 1;
        });
        late(ctx);
        await eventually(() => lateRan);
        expect(warn.mock.calls.some(([m]) => String(m).includes('already disposed'))).toBe(true);
    });

    it('a claim after disposal clears straggler-repopulated memo values', async () => {
        // Request A's straggler recomputes AFTER disposal (accessors memoize
        // onto a disposed store); the value must not leak into request B,
        // which begins at the next claim over the same reused bag.
        let computed = 0;
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return ++computed;
        });
        const fn = serverFn(async (rq) => value(rq));
        const locals: Record<string, unknown> = {};
        const request = new Request(`${ORIGIN}/page`);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        void warn;
        await runInScope({ request, locals }, async () => {
            await expect(fn()).resolves.toBe(1);
        });
        await eventually(() => disposed); // render A's disposal completed
        // The straggler: a late access on the dead request's bag — it
        // recomputes (memo was cleared) and memoizes onto the dead store.
        value({ locals } as unknown as ServerFnContext);
        expect(computed).toBe(2);
        // Request B over the SAME bag — the claim starts it clean.
        await runInScope({ request, locals }, async () => {
            await expect(fn()).resolves.toBe(3);
        });
    });
});

/* ------------------------------------------------------------------ */
/* onDispose registration rules                                       */
/* ------------------------------------------------------------------ */

describe('perRequest onDispose — registration rules', () => {
    it('a disposer on an UNOWNED store dev-warns and never runs automatically', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 1;
        });
        // A detached context has no owner — nothing claims it.
        value(createDetachedContext());
        expect(warn.mock.calls.some(([m]) => String(m).includes('no owner'))).toBe(true);
        await tick();
        await tick();
        expect(disposed).toBe(false); // GC-only; disposeRequestValues is the app's trigger
    });

    it('registration after the synchronous prefix warns but still registers', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let disposed = false;
        const value = perRequest(async (_rq, onDispose) => {
            await tick();
            onDispose(() => void (disposed = true)); // late — after the first await
            return 1;
        });
        const ctx = createDetachedContext();
        await value(ctx);
        expect(warn.mock.calls.some(([m]) => String(m).includes('synchronous prefix'))).toBe(true);
        await disposeRequestValues(ctx);
        expect(disposed).toBe(true); // a warned leak beats a silent one
    });

    it('registration during an in-flight drain runs the disposer immediately, with a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createDetachedContext();
        let lateRan = false;
        let registerLate!: () => void;
        const value = perRequest((_rq, onDispose) => {
            // An async disposer keeps the drain in flight…
            onDispose(async () => {
                await tick();
            });
            registerLate = () => onDispose(() => void (lateRan = true));
            return 1;
        });
        value(ctx);
        const disposal = disposeRequestValues(ctx);
        // …so this registration arrives on a store already marked disposed.
        registerLate();
        await disposal;
        await eventually(() => lateRan);
        expect(warn.mock.calls.some(([m]) => String(m).includes('already disposed'))).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* scope ownership + keepAlive                                        */
/* ------------------------------------------------------------------ */

describe('runInScope — ownership and keepAlive', () => {
    it('an owned (minted) store disposes when the scoped work settles', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const fn = serverFn(async (rq) => value(rq));
        await runInScope(new Request(`${ORIGIN}/page`), async () => {
            await fn();
            expect(disposed).toBe(false); // mid-request
        });
        await eventually(() => disposed);
    });

    it('keepAlive defers disposal past the scope settle; multiple accumulate', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const fn = serverFn(async (rq) => value(rq));
        let releaseA!: () => void;
        let releaseB!: () => void;
        const scope = (globalThis as {
            __SIGX_SERVERFN_SCOPE__?: { keepAlive(until: Promise<unknown>): void };
        }).__SIGX_SERVERFN_SCOPE__!;
        await runInScope(new Request(`${ORIGIN}/page`), async () => {
            scope.keepAlive(new Promise<void>((r) => (releaseA = r)));
            scope.keepAlive(new Promise<void>((r) => (releaseB = r)));
            await fn();
        });
        await tick();
        await tick();
        expect(disposed).toBe(false); // scope settled, keepAlives pending
        releaseA();
        await tick();
        await tick();
        expect(disposed).toBe(false); // BOTH must settle
        releaseB();
        await eventually(() => disposed);
    });

    it('a keepAlive registered while another drains is honored', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const fn = serverFn(async (rq) => value(rq));
        const scope = (globalThis as {
            __SIGX_SERVERFN_SCOPE__?: { keepAlive(until: Promise<unknown>): void };
        }).__SIGX_SERVERFN_SCOPE__!;
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        let releaseGate!: () => void;
        await runInScope(new Request(`${ORIGIN}/page`), async () => {
            scope.keepAlive(new Promise<void>((r) => (releaseFirst = r)));
            // A continuation CREATED inside the scope keeps the ALS context,
            // so this registration lands on the same store even though it
            // fires after run() has settled — exactly the late-registration
            // shape a body pump produces.
            void new Promise<void>((r) => (releaseGate = r)).then(() => {
                scope.keepAlive(new Promise<void>((r) => (releaseSecond = r)));
            });
            await fn();
        });
        releaseGate(); // registers the second keepAlive while the drain awaits the first
        await tick();
        await tick();
        releaseFirst();
        await tick();
        await tick();
        expect(disposed).toBe(false); // the drain loop re-checks the list
        releaseSecond();
        await eventually(() => disposed);
    });

    it('keepAlive outside any scope is a silent no-op', () => {
        const scope = (globalThis as {
            __SIGX_SERVERFN_SCOPE__?: { keepAlive(until: Promise<unknown>): void };
        }).__SIGX_SERVERFN_SCOPE__!;
        expect(() => scope.keepAlive(Promise.resolve())).not.toThrow();
    });

    it('a nested same-request scope does not dispose — the outer entry does', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const fn = serverFn(async (rq) => value(rq));
        const request = new Request(`${ORIGIN}/page`);
        await runInScope(request, async () => {
            await runInScope(request, async () => {
                await fn();
            });
            await tick();
            await tick();
            expect(disposed).toBe(false); // inner settle must NOT dispose
        });
        await eventually(() => disposed);
    });

    it('the documented pre-seed recipe disposes at the outer settle', async () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        const fn = serverFn(async (rq) => value(rq));
        const locals: Record<string, unknown> = { user: 'alice' };
        await runInScope({ request: new Request(`${ORIGIN}/page`), locals }, async () => {
            await fn();
        });
        await eventually(() => disposed);
    });
});

/* ------------------------------------------------------------------ */
/* the endpoint — buffered, form, veto, 500, timeout                  */
/* ------------------------------------------------------------------ */

describe('handleServerFnRequest — disposal at settle', () => {
    const disposable = (onRun?: () => void) => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            onRun?.();
            return 'v';
        });
        return { value, isDisposed: () => disposed };
    };

    it('after a buffered 200', async () => {
        const d = disposable();
        const fn = serverFn(async (rq) => d.value(rq));
        const res = await post(fn);
        expect(res.status).toBe(200);
        await eventually(d.isDisposed);
    });

    it('after a policy veto (401) and after a masked 500', async () => {
        const d = disposable();
        // A vetoing policy is the v4 analog of the vetoing guard: it runs
        // inside the request scope, so a value it touched still disposes.
        const veto = serverFn({
            authorize: (_p, rq) => {
                d.value(rq);
                throw new ServerFnError(401, 'no');
            },
            handler: async () => 'never'
        });
        expect((await post(veto)).status).toBe(401);
        await eventually(d.isDisposed);

        const e = disposable();
        const boom = serverFn(async (rq) => {
            e.value(rq);
            throw new Error('secret');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await post(boom)).status).toBe(500);
        await eventually(e.isDisposed);
    });

    it('after a form 303', async () => {
        const d = disposable();
        const submit = serverFn({
            form: true,
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (value: unknown) => ({ value: value as Record<string, string> })
                }
            },
            handler: async (rq, _input: Record<string, string>) => {
                d.value(rq);
                return 'ok';
            }
        });
        const body = new URLSearchParams({ name: 'x' });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/d_fn_00000001`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    origin: ORIGIN,
                    referer: `${ORIGIN}/form`
                },
                body
            }),
            { resolve: () => submit }
        );
        expect(res.status).toBe(303);
        await eventually(d.isDisposed);
    });

    it('THE timeout pin: a 504 does not dispose ahead of the settling handler', async () => {
        const d = disposable();
        let releaseHandler!: () => void;
        const gate = new Promise<void>((r) => (releaseHandler = r));
        const slow = serverFn(async (rq) => {
            d.value(rq);
            await gate;
            return 'late';
        });
        const res = await post(slow, { timeoutMs: 20 });
        expect(res.status).toBe(504);
        // The 504 is delivered; the handler is still running: NOT disposed.
        await tick();
        await tick();
        expect(d.isDisposed()).toBe(false);
        releaseHandler();
        await eventually(d.isDisposed);
    });

    it('a stream that lost the timeout race still runs its finally and disposes', async () => {
        const d = disposable();
        let cleaned = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const s = serverStream(async function* (rq) {
            d.value(rq);
            try {
                await gate; // never yields before the timeout
                yield 'late';
            } finally {
                cleaned = true;
            }
        });
        const res = await post(s, { timeoutMs: 20 });
        expect(res.status).toBe(504);
        release();
        await eventually(() => cleaned);
        await eventually(d.isDisposed);
    });
});

/* ------------------------------------------------------------------ */
/* the endpoint — stream terminals                                    */
/* ------------------------------------------------------------------ */

describe('handleServerFnRequest — stream terminal disposal', () => {
    const disposable = () => {
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void (disposed = true));
            return 'v';
        });
        return { value, isDisposed: () => disposed };
    };

    it('normal end — and the generator finally runs BEFORE the disposers (the ordering pin)', async () => {
        const order: string[] = [];
        let disposed = false;
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => {
                order.push('disposer');
                disposed = true;
            });
            return 'v';
        });
        const s = serverStream(async function* (rq) {
            value(rq);
            try {
                yield 'a';
                yield 'b';
            } finally {
                order.push('finally');
            }
        });
        const res = await post(s);
        await res.text(); // consume to completion
        await eventually(() => disposed);
        expect(order).toEqual(['finally', 'disposer']);
    });

    it('empty generator', async () => {
        const d = disposable();
        const s = serverStream(async function* (rq) {
            d.value(rq);
        });
        const res = await post(s);
        await expect(res.text()).resolves.toBe('{"done":1}\n');
        await eventually(d.isDisposed);
    });

    it('mid-stream throw', async () => {
        const d = disposable();
        const s = serverStream(async function* (rq) {
            d.value(rq);
            yield 'a';
            throw new Error('mid');
        });
        vi.stubEnv('NODE_ENV', 'production');
        const res = await post(s, {});
        const text = await res.text();
        expect(text).toContain('"error"');
        await eventually(d.isDisposed);
    });

    it('client cancel', async () => {
        const d = disposable();
        let cleaned = false;
        const s = serverStream(async function* (rq) {
            d.value(rq);
            try {
                yield 'a';
                yield 'b';
                yield 'c';
            } finally {
                cleaned = true;
            }
        });
        const res = await post(s);
        const reader = res.body!.getReader();
        await reader.read();
        await reader.cancel();
        await eventually(() => cleaned);
        await eventually(d.isDisposed);
    });

    it('pre-first-yield throw disposes in order and stays a buffered error', async () => {
        const order: string[] = [];
        const value = perRequest((_rq, onDispose) => {
            onDispose(() => void order.push('disposer'));
            return 'v';
        });
        const s = serverStream(async function* (rq) {
            value(rq);
            try {
                throw new Error('before any yield');
            } finally {
                order.push('finally');
            }
            yield 'never';
        });
        vi.stubEnv('NODE_ENV', 'production');
        const res = await post(s);
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('application/json');
        await eventually(() => order.length === 2);
        expect(order).toEqual(['finally', 'disposer']);
    });
});
