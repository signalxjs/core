/**
 * @vitest-environment node
 *
 * @sigx/server/testing (#570) — the public testing surface. The factory is
 * the third remedy the detached-context error names; the stamp is the build
 * marker `useData(fn)` needs. Guard-chain testing deliberately has NO new
 * invoker — `fn.with({ context })(…)` runs the whole in-process pipeline,
 * and two cases below are that recipe, executable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createTestServerFnContext,
    stampServerFnKey,
    type TestServerFnContext
} from '../src/testing';
import {
    serverFn,
    serverStream,
    serverFnPreset,
    perRequest,
    ServerFnError,
    type StandardSchemaV1
} from '../src/index';
import { createDetachedContext } from '../src/context';
import { runWithServerFnContext } from '../src/node';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createTestServerFnContext — defaults', () => {
    it('rq.request and rq.url work with no arguments', () => {
        const ctx = createTestServerFnContext();
        expect(ctx.request).toBeInstanceOf(Request);
        expect(ctx.url.href).toBe('http://localhost/');
        expect(ctx.responseHeaders).toBeInstanceOf(Headers);
        expect(ctx.locals).toEqual({});
    });

    it('a supplied Request drives url, headers, and abortSignal', () => {
        const controller = new AbortController();
        const req = new Request('https://example.com/cart?x=1', {
            headers: { cookie: 'session=alice' },
            signal: controller.signal
        });
        const ctx = createTestServerFnContext(req);
        expect(ctx.request).toBe(req);
        expect(ctx.url.pathname).toBe('/cart');
        expect(ctx.request.headers.get('cookie')).toBe('session=alice');
        controller.abort();
        expect(ctx.abortSignal.aborted).toBe(true);
    });

    it('a partial with only locals STILL has a working rq.request', () => {
        // The differentiator vs. a bare fn.with({ context: { locals } }),
        // which keeps the detached throw for rq.request.
        const ctx = createTestServerFnContext({ locals: { user: 'bob' } });
        expect(ctx.request).toBeInstanceOf(Request);
        expect(ctx.locals.user).toBe('bob');
    });

    it('caller-supplied locals keep their identity', () => {
        const locals = { user: 'bob' };
        const ctx = createTestServerFnContext({ locals });
        expect(ctx.locals).toBe(locals);
    });

    it('a previously built context as init does not trip the throwing getters', () => {
        // A detached context has enumerable throwing request/url getters —
        // guarded per-key copy must read them safely, and the factory then
        // fills the request the source could not provide.
        const detached = createDetachedContext();
        const ctx = createTestServerFnContext(detached);
        expect(ctx.request).toBeInstanceOf(Request);
        expect(ctx.locals).toBe(detached.locals);
    });
});

describe('createTestServerFnContext — status and headers', () => {
    it('rq.status(code) records to statusCode without warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createTestServerFnContext();
        expect(ctx.statusCode).toBeUndefined();
        const created = serverFn(async (rq) => {
            rq.status(201);
            return 'ok';
        });
        await expect(created.with({ context: ctx })()).resolves.toBe('ok');
        expect(ctx.statusCode).toBe(201);
        expect(warn).not.toHaveBeenCalled();
    });

    it('a caller-supplied status wins over the recorder', () => {
        const seen: number[] = [];
        const ctx = createTestServerFnContext({ status: (code) => void seen.push(code) });
        ctx.status(418);
        expect(seen).toEqual([418]);
        expect(ctx.statusCode).toBeUndefined();
    });

    it('statusCode is non-enumerable — it never rides into scope merges', () => {
        const ctx = createTestServerFnContext();
        expect(Object.keys(ctx)).not.toContain('statusCode');
    });

    it('responseHeaders set by a handler are assertable on the context', async () => {
        const ctx = createTestServerFnContext();
        const setsCookie = serverFn(async (rq) => {
            rq.responseHeaders.set('set-cookie', 'seen=1');
            return 'ok';
        });
        await setsCookie.with({ context: ctx })();
        expect(ctx.responseHeaders.get('set-cookie')).toBe('seen=1');
    });
});

describe('createTestServerFnContext — the store-identity rule', () => {
    it('one context = one perRequest store across calls; two contexts = two', async () => {
        let computed = 0;
        const counter = perRequest(() => ++computed);
        const read = serverFn(async (rq) => counter(rq));

        const ctx = createTestServerFnContext();
        await expect(read.with({ context: ctx })()).resolves.toBe(1);
        await expect(read.with({ context: ctx })()).resolves.toBe(1); // memoized: same request

        const other = createTestServerFnContext();
        await expect(read.with({ context: other })()).resolves.toBe(2); // fresh store
    });

    it('an explicit factory context wins over an ambient scope', async () => {
        const whoAmI = serverFn(async (rq) => rq.url.pathname);
        const ctx = createTestServerFnContext(new Request('http://localhost/explicit'));
        await runWithServerFnContext(new Request('http://localhost/ambient'), async () => {
            await expect(whoAmI.with({ context: ctx })()).resolves.toBe('/explicit');
            await expect(whoAmI()).resolves.toBe('/ambient');
        });
    });
});

describe('guard chains through the public surface — no invoker needed', () => {
    const requireUser = (rq: { locals: Record<string, unknown> }): void => {
        if (!rq.locals.user) throw new ServerFnError(401, 'sign in first');
    };

    it('fn.with({ context }) runs preset + use guards — a veto rejects 401', async () => {
        const authed = serverFnPreset({ use: [requireUser] });
        const secret = authed(async () => 'data');

        const anon = createTestServerFnContext();
        const error = await secret.with({ context: anon })().catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(401);

        const alice = createTestServerFnContext({ locals: { user: 'alice' } });
        await expect(secret.with({ context: alice })()).resolves.toBe('data');
    });

    it('…and input validation — invalid input rejects 400 with issues', async () => {
        const schema: StandardSchemaV1<{ id: string }> = {
            '~standard': {
                version: 1,
                vendor: 'test',
                validate: (value) =>
                    typeof (value as { id?: unknown })?.id === 'string'
                        ? { value: value as { id: string } }
                        : { issues: [{ message: 'id must be a string' }] }
            }
        };
        const load = serverFn({ input: schema, handler: async (_rq, input) => input.id });
        const ctx = createTestServerFnContext();
        const error = await load
            .with({ context: ctx })({ id: 42 } as unknown as { id: string })
            .catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(400);
        expect((error as ServerFnError).data).toEqual({
            issues: [{ message: 'id must be a string' }]
        });
    });
});

describe('stampServerFnKey', () => {
    it('returns the SAME fn with a non-empty key and the guard-checked stamp', () => {
        const getVotes = serverFn(async function getVotes() {
            return 42;
        });
        const stamped = stampServerFnKey(getVotes);
        expect(stamped).toBe(getVotes);
        expect(stamped.__sigxKey).toBe('test/getVotes');
        expect(stamped.__sigxGuardChecked).toBe(true);
    });

    it('an explicit key wins verbatim', () => {
        const fn = serverFn(async () => 1);
        expect(stampServerFnKey(fn, 'board/issues').__sigxKey).toBe('board/issues');
    });

    it('__DEV__: the empty-string sentinel throws', () => {
        const fn = serverFn(async () => 1);
        expect(() => stampServerFnKey(fn, '')).toThrow(/UNSTAMPED sentinel/);
    });

    it('__DEV__: a serverStream throws — streams are not useData targets', () => {
        const feed = serverStream(async function* () {
            yield 1;
        });
        expect(() => stampServerFnKey(feed)).toThrow(/not a useData\s+target/);
    });

    it('an anonymous fn falls back to test/fn', () => {
        const fn = serverFn(async () => 1);
        // The wrapper mints __sigxName from the impl's .name; an arrow bound
        // to a const gets that const's name, so blank it to simulate a truly
        // anonymous impl.
        (fn as { __sigxName: string }).__sigxName = '';
        expect(stampServerFnKey(fn).__sigxKey).toBe('test/fn');
    });
});

// Compile-time pin: the factory's return type IS a ServerFnContext.
const _typeCheck: TestServerFnContext = createTestServerFnContext();
void _typeCheck;
