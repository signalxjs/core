/**
 * @vitest-environment node
 *
 * Server-declared cache directives (rfc-server §6.2, #311): the options
 * form's `invalidates` seam, the endpoint's `$cache` envelope field, and
 * the fn stub's delivery to the global cache seam.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { serverFn, ServerFnError } from '../src/index';
import { handleServerFnRequest } from '../src/server/index';
import { __serverFnStub, type ServerFnCacheDirectives } from '../src/client/index';

const ORIGIN = 'http://localhost';

const post = (fn: unknown, body = '{"args":[{}]}'): Promise<Response> =>
    handleServerFnRequest(
        new Request(`${ORIGIN}/_sigx/fn/m_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body
        }),
        { resolve: () => fn }
    );

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (globalThis as { __SIGX_SERVERFN_CACHE__?: unknown }).__SIGX_SERVERFN_CACHE__;
});

describe('serverFn — invalidates (endpoint envelope)', () => {
    it('attaches $cache.invalidates computed from the VALIDATED input and the result', async () => {
        const addToCart = serverFn({
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (value) => ({ value: { id: String((value as { id?: unknown })?.id) } })
                }
            },
            handler: async (_rq, input: { id: string }) => ({ count: 3, id: input.id }),
            // After `handler` in the literal so TS infers `result` (see the
            // ServerFnOptions doc note).
            invalidates: (input, result) => [['cart', input.id], `total:${result.count}`]
        });
        const res = await post(addToCart, '{"args":[{"id":42}]}');
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({
            data: { count: 3, id: '42' },
            $cache: { invalidates: [['cart', '42'], 'total:3'] }
        });
    });

    it('supports an async invalidates and omits $cache when it returns nothing', async () => {
        const asyncKeys = serverFn({
            invalidates: async () => [['a']],
            handler: async () => 'ok'
        });
        await expect((await post(asyncKeys)).json()).resolves.toEqual({
            data: 'ok',
            $cache: { invalidates: [['a']] }
        });

        const empty = serverFn({ invalidates: () => [], handler: async () => 'ok' });
        await expect((await post(empty)).json()).resolves.toEqual({ data: 'ok' });

        const plain = serverFn({ handler: async () => 'ok' });
        await expect((await post(plain)).json()).resolves.toEqual({ data: 'ok' });
    });

    it('an undefined result still carries $cache (a mutation may return nothing)', async () => {
        const fire = serverFn({
            invalidates: () => [['cart']],
            handler: async () => undefined
        });
        await expect((await post(fire)).json()).resolves.toEqual({
            $cache: { invalidates: [['cart']] }
        });
    });

    it('a throwing invalidates is a fn error — masked in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const boom = serverFn({
            invalidates: () => {
                throw new Error('secret key derivation');
            },
            handler: async () => 'ok'
        });
        const res = await post(boom);
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error.message).toBe('Internal error');
        expect(JSON.stringify(body)).not.toContain('secret key derivation');
    });

    it('in-process calls never compute directives (wire-only)', async () => {
        const invalidates = vi.fn(() => [['cart']]);
        const fn = serverFn({ invalidates, handler: async () => 'ok' });
        await expect(fn({})).resolves.toBe('ok');
        expect(invalidates).not.toHaveBeenCalled();
    });
});

describe('__serverFnStub — $cache delivery', () => {
    const stubFetch = (body: unknown, status = 200): void => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    };
    const installSeam = (): ReturnType<typeof vi.fn> => {
        const hook = vi.fn();
        (globalThis as { __SIGX_SERVERFN_CACHE__?: unknown }).__SIGX_SERVERFN_CACHE__ = hook;
        return hook;
    };

    it('delivers $cache to the global seam and still resolves the data', async () => {
        const hook = installSeam();
        stubFetch({ data: 7, $cache: { invalidates: [['cart']] } });
        const fn = __serverFnStub('m_fn_00000001', 'add', '/_sigx/fn');
        await expect(fn()).resolves.toBe(7);
        expect(hook).toHaveBeenCalledExactlyOnceWith({
            invalidates: [['cart']]
        } satisfies ServerFnCacheDirectives);
    });

    it('no $cache in the envelope ⇒ the seam is not called', async () => {
        const hook = installSeam();
        stubFetch({ data: 7 });
        const fn = __serverFnStub('m_fn_00000001', 'add', '/_sigx/fn');
        await expect(fn()).resolves.toBe(7);
        expect(hook).not.toHaveBeenCalled();
    });

    it('a throwing seam never breaks the RPC result', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        (globalThis as { __SIGX_SERVERFN_CACHE__?: unknown }).__SIGX_SERVERFN_CACHE__ = () => {
            throw new Error('cache pack bug');
        };
        stubFetch({ data: 7, $cache: { invalidates: [['cart']] } });
        const fn = __serverFnStub('m_fn_00000001', 'add', '/_sigx/fn');
        await expect(fn()).resolves.toBe(7);
        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it('no seam installed ⇒ directives are dropped silently', async () => {
        stubFetch({ data: 7, $cache: { invalidates: [['cart']] } });
        const fn = __serverFnStub('m_fn_00000001', 'add', '/_sigx/fn');
        await expect(fn()).resolves.toBe(7);
    });

    it('error envelopes never reach the seam', async () => {
        const hook = installSeam();
        stubFetch({ error: { message: 'nope', status: 403 } }, 403);
        const fn = __serverFnStub('m_fn_00000001', 'add', '/_sigx/fn');
        await expect(fn()).rejects.toMatchObject({ status: 403 });
        expect(hook).not.toHaveBeenCalled();
    });
});

describe('composition sanity', () => {
    it('ServerFnError from the handler still wins over invalidates', async () => {
        const invalidates = vi.fn(() => [['cart']]);
        const fn = serverFn({
            invalidates,
            handler: async () => {
                throw new ServerFnError(409, 'conflict');
            }
        });
        const res = await post(fn);
        expect(res.status).toBe(409);
        expect(invalidates).not.toHaveBeenCalled();
    });
});
