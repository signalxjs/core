/**
 * @vitest-environment node
 *
 * The request SCOPE (rfc-server §7 v1.1, #309) — the half that OPENS what
 * `resolveInProcessContext` reads: the `__SIGX_SERVERFN_SCOPE__` seam the
 * document handlers use, the Node `IncomingMessage` normalization they need
 * (they hold no `Request`), and the endpoint scoping its own invocation.
 */

import { describe, it, expect, vi } from 'vitest';
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

/* ------------------------------------------------------------------ */
/* nested scopes (rfc-server-v3 §2.7, F-D, #495)                       */
/* ------------------------------------------------------------------ */

describe('nested scopes', () => {
    /** The documented pre-seed recipe, wrapped around a render that opens its
     *  own scope with the raw node request — which is what the document
     *  handlers in @sigx/server-renderer do. */
    const render = async <T,>(fn: () => Promise<T>): Promise<T> =>
        runInScope(nodeRequest({ host: 'app.test' }, '/board'), fn);

    const preSeed = {
        request: new Request('http://app.test/board'),
        locals: { user: 'alice' } as Record<string, unknown>
    };

    it('the documented pre-seed survives the renderer’s inner scope', async () => {
        const read = serverFn(async (rq) => rq.locals.user);
        // Before #495 the inner scope REPLACED the store and this was
        // undefined — silently, which is what made it the first thing an app
        // reached for and the first thing that failed.
        await expect(runInScope(preSeed, () => render(() => read()))).resolves.toBe('alice');
    });

    it('shares one store — a value written inside reaches the outer bag', async () => {
        const write = serverFn(async (rq) => {
            rq.locals.seen = true;
            return null;
        });
        await runInScope(preSeed, () => render(() => write()));
        expect(preSeed.locals.seen).toBe(true);
        delete preSeed.locals.seen;
    });

    it('the inner source’s fields win where supplied', async () => {
        const read = serverFn(async (rq) => [rq.url.pathname, rq.request.headers.get('cookie')]);
        const seen = await runInScope(preSeed, () =>
            runInScope(nodeRequest({ host: 'app.test', cookie: 'sid=1' }, '/board'), () => read())
        );
        // The inner request is the one in scope…
        expect(seen).toEqual(['/board', 'sid=1']);
    });

    it('a DIFFERENT url opens a fresh store', async () => {
        const read = serverFn(async (rq) => rq.locals.user);
        await expect(
            runInScope(preSeed, () =>
                runInScope(nodeRequest({ host: 'app.test' }, '/other'), () => read())
            )
        ).resolves.toBeUndefined();
    });

    it('a DIFFERENT method opens a fresh store', async () => {
        const read = serverFn(async (rq) => rq.locals.user);
        const inner = { ...nodeRequest({ host: 'app.test' }, '/board'), method: 'POST' };
        await expect(
            runInScope(preSeed, () => runInScope(inner, () => read()))
        ).resolves.toBeUndefined();
    });

    it('a protocol-only difference does NOT split — the proxy case', async () => {
        // The outer key is built from a hand-rolled http:// Request; the inner
        // from a node request behind a TLS-terminating proxy. Same request.
        const read = serverFn(async (rq) => rq.locals.user);
        await expect(
            runInScope(preSeed, () =>
                runInScope(
                    nodeRequest({ host: 'app.test', 'x-forwarded-proto': 'https' }, '/board'),
                    () => read()
                )
            )
        ).resolves.toBe('alice');
    });

    it('an enclosing init with no request always merges — the {locals}-only pre-seed', async () => {
        const read = serverFn(async (rq) => rq.locals.user);
        // Makes no claim about which request it is, so merging is unambiguous.
        await expect(
            runInScope({ locals: { user: 'bob' } }, () => render(() => read()))
        ).resolves.toBe('bob');
    });

    it('an inner source carrying its OWN locals keeps them — the isolation hatch', async () => {
        const read = serverFn(async (rq) => rq.locals.user);
        await expect(
            runInScope(preSeed, () =>
                runInScope({ request: new Request('http://app.test/board'), locals: {} }, () =>
                    read()
                )
            )
        ).resolves.toBeUndefined();
    });

    it('sibling (non-nested) scopes still isolate', async () => {
        const seed = serverFn(async (rq, value: string) => {
            rq.locals.user = value;
            return null;
        });
        const read = serverFn(async (rq) => rq.locals.user);
        const one = async (value: string): Promise<unknown> =>
            runInScope(nodeRequest({ host: 'app.test' }, '/board'), async () => {
                await seed(value);
                await new Promise((resolve) => setTimeout(resolve, 1));
                return read();
            });
        await expect(Promise.all([one('alice'), one('bob')])).resolves.toEqual(['alice', 'bob']);
    });
});

describe('the different-request notice', () => {
    it('names both keys and fires once per process', async () => {
        // A fresh module graph, so the once-per-process latch is unset —
        // asserting it from a shared graph would only ever prove test order.
        vi.resetModules();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const scope = await import('../src/scope');
            const outer = { request: new Request('http://app.test/board'), locals: {} };

            await scope.runInScope(outer, () =>
                scope.runInScope(nodeRequest({ host: 'app.test' }, '/subrequest'), () => null)
            );
            await scope.runInScope(outer, () =>
                scope.runInScope(nodeRequest({ host: 'app.test' }, '/another'), () => null)
            );

            const notices = warn.mock.calls
                .map(([m]) => String(m))
                .filter((m) => m.includes('names a different request'));
            expect(notices).toHaveLength(1);
            // Both keys, so the author can see WHY the merge was declined —
            // a host rewritten by a proxy is the likely surprise.
            expect(notices[0]).toContain('GET app.test/board');
            expect(notices[0]).toContain('GET app.test/subrequest');
            expect(notices[0]).toContain('its OWN request store');
        } finally {
            warn.mockRestore();
            vi.resetModules();
        }
    });
});
