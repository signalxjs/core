/**
 * @vitest-environment node
 *
 * The request SCOPE (rfc-server §7 v1.1, #309) — the half that OPENS what
 * `resolveInProcessContext` reads: the `__SIGX_SERVERFN_SCOPE__` seam the
 * document handlers use, the Node `IncomingMessage` normalization they need
 * (they hold no `Request`), and the endpoint scoping its own invocation.
 */

import { describe, it, expect } from 'vitest';
import { serverFn } from '../src/index';
import { handleServerFnRequest } from '../src/server/index';
import { runInScope, toContextInit, toScopeInit, type ServerFnScope } from '../src/scope';

const post = (symbol: string, args: unknown[] = []): Request =>
    new Request(`http://localhost/_sigx/fn/${symbol}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ args })
    });

/** What `createRequestHandler` hands the scope: a node request, no Request. */
const nodeRequest = (headers: Record<string, string>, url = '/orders?page=2') => ({
    url,
    method: 'GET',
    headers,
    socket: { encrypted: false }
});

describe('the seam', () => {
    it('is stamped at import — a handler can ask before any scope exists', () => {
        const scope = (globalThis as { __SIGX_SERVERFN_SCOPE__?: ServerFnScope })
            .__SIGX_SERVERFN_SCOPE__;
        // `__SIGX_SERVERFN_CONTEXT__` cannot exist until a scope is open; the
        // renderer needs to know on the FIRST request that it can open one.
        expect(typeof scope?.run).toBe('function');
    });
});

describe('node requests', () => {
    it('normalizes an IncomingMessage into the request a call reads', async () => {
        const fn = serverFn(async (rq) => ({
            href: rq.url.href,
            cookie: rq.request.headers.get('cookie'),
            method: rq.request.method
        }));

        await expect(
            runInScope(nodeRequest({ host: 'shop.test', cookie: 'sid=1' }), () => fn())
        ).resolves.toEqual({
            href: 'http://shop.test/orders?page=2',
            cookie: 'sid=1',
            method: 'GET'
        });
    });

    it('honors x-forwarded-proto/host behind a TLS-terminating proxy', async () => {
        const fn = serverFn(async (rq) => rq.url.origin);
        await expect(
            runInScope(
                nodeRequest({
                    host: 'internal:8080',
                    'x-forwarded-proto': 'https,http',
                    'x-forwarded-host': 'shop.test'
                }),
                () => fn()
            )
        ).resolves.toBe('https://shop.test');
    });

    it('passes a WinterCG Request through untouched', () => {
        const request = new Request('https://shop.test/cart');
        expect(toContextInit(request)).toBe(request);
    });

    it('passes a partial context through untouched', () => {
        const partial = { locals: { user: 'ada' } };
        expect(toContextInit(partial)).toBe(partial);
    });

    it('does not mistake a null-headers object for a node request', () => {
        // typeof null === 'object', so a sloppier check would classify this
        // as a node request and throw in Object.entries instead.
        const partial = { headers: null } as never;
        expect(toContextInit(partial)).toBe(partial);
    });
});

describe('scoping', () => {
    it('isolates concurrent scopes — the point of AsyncLocalStorage', async () => {
        const fn = serverFn(async (rq, delay: number) => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return rq.url.pathname;
        });

        // The slow request enters first and leaves last: a module-level
        // "current request" would report /fast for both.
        const [slow, fast] = await Promise.all([
            runInScope(new Request('https://shop.test/slow'), () => fn(20)),
            runInScope(new Request('https://shop.test/fast'), () => fn(0))
        ]);
        expect(slow).toBe('/slow');
        expect(fast).toBe('/fast');
    });

    it('survives awaits inside the scope, including nested calls', async () => {
        const inner = serverFn(async (rq) => rq.url.pathname);
        const outer = serverFn(async () => {
            await Promise.resolve();
            return inner();
        });
        await expect(
            runInScope(new Request('https://shop.test/deep'), () => outer())
        ).resolves.toBe('/deep');
    });
});

describe('the endpoint scopes its own invocation', () => {
    it('hands the live request to a nested in-process call', async () => {
        const inner = serverFn(async (rq) => rq.url.pathname);
        const outer = serverFn(async () => inner());

        const response = await handleServerFnRequest(post('outer_fn_00000000'), {
            resolve: () => outer
        });

        expect(response.status).toBe(200);
        // Without the endpoint's scope this was the detached context, and the
        // nested read threw — a masked 500 with the live request one frame up.
        await expect(response.json()).resolves.toEqual({ data: '/_sigx/fn/outer_fn_00000000' });
    });

    it('still isolates one request from another', async () => {
        const inner = serverFn(async (rq) => rq.url.search);
        const outer = serverFn(async () => inner());
        const [a, b] = await Promise.all([
            handleServerFnRequest(
                new Request('http://localhost/_sigx/fn/outer_fn_00000000?who=a', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
                    body: JSON.stringify({ args: [] })
                }),
                { resolve: () => outer }
            ).then((r) => r.json()),
            handleServerFnRequest(
                new Request('http://localhost/_sigx/fn/outer_fn_00000000?who=b', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
                    body: JSON.stringify({ args: [] })
                }),
                { resolve: () => outer }
            ).then((r) => r.json())
        ]);
        expect(a).toEqual({ data: '?who=a' });
        expect(b).toEqual({ data: '?who=b' });
    });
});

/* ------------------------------------------------------------------ */
/* the per-request store (rfc-server-v3 §2.3, #494)                    */
/* ------------------------------------------------------------------ */

describe('the per-request store', () => {
    it('gives every in-process call in one scope the SAME locals bag', async () => {
        const bags: unknown[] = [];
        const capture = serverFn(async (rq) => {
            bags.push(rq.locals);
            return null;
        });

        await runInScope(nodeRequest({ host: 'app.test' }), async () => {
            await capture();
            await capture();
        });
        // Before #494 each call materialized its own `{}` from the bare
        // Request the scope stored, so a guard could not hand anything to the
        // next call.
        expect(bags[0]).toBe(bags[1]);
    });

    it('lets a guard hand a value to a LATER call in the same render', async () => {
        const seed = serverFn(async (rq) => {
            rq.locals.user = 'alice';
            return null;
        });
        const read = serverFn(async (rq) => rq.locals.user);

        await expect(
            runInScope(nodeRequest({ host: 'app.test' }), async () => {
                await seed();
                return read();
            })
        ).resolves.toBe('alice');
    });

    it('keeps two concurrent renders apart', async () => {
        const seed = serverFn(async (rq, value: string) => {
            rq.locals.user = value;
            return null;
        });
        const read = serverFn(async (rq) => rq.locals.user);

        const render = async (value: string): Promise<unknown> =>
            runInScope(nodeRequest({ host: 'app.test' }), async () => {
                await seed(value);
                await new Promise((resolve) => setTimeout(resolve, 1));
                return read();
            });

        await expect(Promise.all([render('alice'), render('bob')])).resolves.toEqual([
            'alice',
            'bob'
        ]);
    });

    it('preserves the caller’s own bag by IDENTITY — the documented pre-seed', async () => {
        const seeded = { user: 'alice' };
        const read = serverFn(async (rq) => rq.locals);

        const seen = await runInScope({ request: new Request('https://app.test/'), locals: seeded }, () =>
            read()
        );
        expect(seen).toBe(seeded);
    });

    it('a bare Request still carries its abort signal after the wrap', async () => {
        const controller = new AbortController();
        controller.abort();
        const read = serverFn(async (rq) => rq.abortSignal.aborted);

        await expect(
            runInScope(new Request('https://app.test/', { signal: controller.signal }), () => read())
        ).resolves.toBe(true);
    });

    it('the endpoint’s own context stays the store — guard writes reach the handler', async () => {
        const whoami = serverFn(async (rq) => rq.locals.user);
        const res = await handleServerFnRequest(post('who_fn_1'), {
            resolve: () => whoami,
            guard: (rq) => {
                rq.locals.user = 'andy';
            }
        });
        await expect(res.json()).resolves.toEqual({ data: 'andy' });
    });
});

describe('toScopeInit', () => {
    it('adds a locals bag without copying one that already exists', () => {
        const bare = new Request('https://app.test/');
        const wrapped = toScopeInit(bare);
        expect(wrapped.request).toBe(bare);
        expect(wrapped.locals).toEqual({});

        const own = { request: bare, locals: { user: 'alice' } };
        expect(toScopeInit(own)).toBe(own);

        const node = toScopeInit(nodeRequest({ host: 'app.test' }));
        expect(node.request).toBeInstanceOf(Request);
        expect(node.locals).toEqual({});
    });
});
