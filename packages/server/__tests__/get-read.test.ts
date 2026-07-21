/**
 * @vitest-environment node
 *
 * GET + cache semantics for idempotent reads (rfc-server §4.1/§5.2a, #354):
 * method gating, query-string argument decoding (codec tags included),
 * Cache-Control/Vary emission, the non-2xx no-store rule, Origin semantics
 * on a safe method, and pipeline parity with POST.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleServerFnRequest, type ServerFnRequestOptions } from '../src/server/index';
import { serverFn, serverStream, ServerFnError } from '../src/index';
import { encodeWire } from '../src/wire-codec';

const ORIGIN = 'http://localhost';

const read = serverFn({
    cache: { maxAge: 60 },
    handler: async (_rq, input: { id: string }) => ({ id: input.id, hit: true })
});
const readSwr = serverFn({
    cache: { maxAge: 60, staleWhileRevalidate: 300 },
    handler: async () => 'swr'
});
const readPublic = serverFn({
    cache: { maxAge: 30, public: true, sMaxAge: 600 },
    handler: async () => 'anyone'
});
const readEcho = serverFn({
    cache: { maxAge: 60 },
    handler: async (_rq, input: unknown) => input
});
const readOwnHeader = serverFn({
    cache: { maxAge: 60 },
    handler: async (rq) => {
        rq.responseHeaders.set('cache-control', 'private, max-age=5');
        return 'dynamic';
    }
});
const readNotFound = serverFn({
    cache: { maxAge: 60 },
    handler: async (rq) => {
        rq.status(404);
        return null;
    }
});
const readBoom = serverFn({
    cache: { maxAge: 60 },
    handler: async () => {
        throw new ServerFnError(418, 'teapot');
    }
});
const postOnly = serverFn(async (_rq, a: number, b: number) => a + b);
const stream = serverStream(async function* (): AsyncGenerator<string> {
    yield 'chunk';
});

const FNS: Record<string, unknown> = {
    read_fn_00000001: read,
    swr_fn_00000002: readSwr,
    public_fn_00000003: readPublic,
    echo_fn_00000004: readEcho,
    own_fn_00000005: readOwnHeader,
    nf_fn_00000006: readNotFound,
    boom_fn_00000007: readBoom,
    add_fn_00000008: postOnly,
    stream_fn_00000009: stream
};

/** Build the stub's GET URL: `?args=<encodeURIComponent(JSON.stringify(encode(args)))>`. */
function getUrl(symbol: string, args?: unknown[]): string {
    const query =
        args === undefined
            ? ''
            : `?args=${encodeURIComponent(JSON.stringify(encodeWire(args)))}`;
    return `${ORIGIN}/_sigx/fn/${symbol}${query}`;
}

function get(
    symbol: string,
    args?: unknown[],
    init: { headers?: Record<string, string>; url?: string } = {},
    options: Partial<ServerFnRequestOptions> = {}
): Promise<Response> {
    // No Origin header by default — a browser's same-origin GET fetch
    // does not send one (§5.2a).
    const request = new Request(init.url ?? getUrl(symbol, args), {
        method: 'GET',
        headers: init.headers ?? {}
    });
    return handleServerFnRequest(request, {
        resolve: (sym) => FNS[sym] ?? null,
        ...options
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('method gating (§4.1)', () => {
    it('serves a cache-marked read over GET', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }]);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: { id: 'p1', hit: true } });
    });

    it('GET to an unmarked fn is a resource-precise 405 (Allow: POST) + no-store', async () => {
        const res = await get('add_fn_00000008', [1, 2]);
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('GET to a serverStream is 405 even though streams carry no cache mark', async () => {
        const res = await get('stream_fn_00000009', []);
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
    });

    it('an unsupported method advertises the endpoint universe (Allow: POST, GET)', async () => {
        const request = new Request(getUrl('read_fn_00000001', []), { method: 'PUT' });
        const res = await handleServerFnRequest(request, { resolve: () => read });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST, GET');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('POST remains valid for a cache-marked read — GET is strictly additive', async () => {
        const request = new Request(`${ORIGIN}/_sigx/fn/read_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ args: [{ id: 'p2' }] })
        });
        const res = await handleServerFnRequest(request, { resolve: () => read });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: { id: 'p2', hit: true } });
        // The POST path never emits the read's Cache-Control.
        expect(res.headers.get('cache-control')).toBeNull();
    });

    it('GET 404s (unknown symbol) are no-store — a cached miss must not shadow a redeploy', async () => {
        const res = await get('gone_fn_ffffffff', []);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
});

describe('query-string arguments (§4.1)', () => {
    it('round-trips codec tags: Date, Map, Set, BigInt, $esc', async () => {
        const date = new Date('2026-07-21T12:00:00Z');
        const input = {
            when: date,
            counts: new Map([['a', 1]]),
            tags: new Set(['x', 'y']),
            total: 9007199254740993n,
            escaped: { $date: 'not a date' }
        };
        const res = await get('echo_fn_00000004', [input]);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: unknown };
        // The envelope encodes the result the same way — assert the wire
        // shape round-trips symmetrically.
        expect(body.data).toEqual(encodeWire(input));
    });

    it('a missing args parameter reads as [] (curl ergonomics)', async () => {
        const res = await get('swr_fn_00000002');
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 'swr' });
    });

    it('malformed JSON in args is a 400 + no-store', async () => {
        const res = await get('read_fn_00000001', undefined, {
            url: `${ORIGIN}/_sigx/fn/read_fn_00000001?args=%7Bnope`
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('non-array args is a 400', async () => {
        const res = await get('read_fn_00000001', undefined, {
            url: `${ORIGIN}/_sigx/fn/read_fn_00000001?args=%7B%7D`
        });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
            error: { message: '"args" must be a JSON array' }
        });
    });

    it('a malformed tag payload is a 400, not a masked 500', async () => {
        const bad = encodeURIComponent(JSON.stringify([{ $bigint: 'zz-not-a-bigint' }]));
        const res = await get('read_fn_00000001', undefined, {
            url: `${ORIGIN}/_sigx/fn/read_fn_00000001?args=${bad}`
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('prototype-pollution keys are DROPPED from query args by the reviver', async () => {
        const raw = encodeURIComponent('[{"__proto__": {"polluted": 1}, "ok": 2}]');
        const res = await get('echo_fn_00000004', undefined, {
            url: `${ORIGIN}/_sigx/fn/echo_fn_00000004?args=${raw}`
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: { ok: 2 } });
    });

    it('an oversized query string is a 414 + no-store', async () => {
        const res = await get('read_fn_00000001', [{ id: 'x'.repeat(10_000) }]);
        expect(res.status).toBe(414);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('maxUrlBytes is configurable', async () => {
        const res = await get('read_fn_00000001', [{ id: 'x'.repeat(200) }], {}, { maxUrlBytes: 64 });
        expect(res.status).toBe(414);
    });
});

describe('Cache-Control emission (§4.1)', () => {
    it('private is the default, with Vary: Cookie', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }]);
        expect(res.headers.get('cache-control')).toBe('private, max-age=60');
        expect(res.headers.get('vary')).toBe('Cookie');
    });

    it('stale-while-revalidate rides along', async () => {
        const res = await get('swr_fn_00000002', []);
        expect(res.headers.get('cache-control')).toBe(
            'private, max-age=60, stale-while-revalidate=300'
        );
    });

    it('public: true emits public + s-maxage and NO Vary', async () => {
        const res = await get('public_fn_00000003', []);
        expect(res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=600');
        expect(res.headers.get('vary')).toBeNull();
    });

    it('a handler-set cache-control wins outright (Vary included)', async () => {
        const res = await get('own_fn_00000005', []);
        expect(res.headers.get('cache-control')).toBe('private, max-age=5');
        expect(res.headers.get('vary')).toBeNull();
    });

    it('a handler-set non-2xx status forces no-store — no cacheable negative lookups', async () => {
        const res = await get('nf_fn_00000006', []);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('a thrown ServerFnError is no-store', async () => {
        const res = await get('boom_fn_00000007', []);
        expect(res.status).toBe(418);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
});

describe('Origin on a safe method (§5.2a)', () => {
    it('an absent Origin is admitted under the default same-origin policy', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }]);
        expect(res.status).toBe(200);
    });

    it('a present, matching Origin is admitted', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }], { headers: { origin: ORIGIN } });
        expect(res.status).toBe(200);
    });

    it('a present, mismatching Origin is still 403 + no-store', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }], {
            headers: { origin: 'https://evil.example' }
        });
        expect(res.status).toBe(403);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('Origin: null is a PRESENT header and rejected', async () => {
        const res = await get('read_fn_00000001', [{ id: 'p1' }], { headers: { origin: 'null' } });
        expect(res.status).toBe(403);
    });

    it('an allowlist admits its origins on GET', async () => {
        const res = await get(
            'read_fn_00000001',
            [{ id: 'p1' }],
            { headers: { origin: 'https://app.example' } },
            { origin: ['https://app.example'] }
        );
        expect(res.status).toBe(200);
    });

    it('POST without an Origin header stays rejected (unchanged posture)', async () => {
        const request = new Request(`${ORIGIN}/_sigx/fn/read_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[{"id":"p1"}]}'
        });
        const res = await handleServerFnRequest(request, { resolve: () => read });
        expect(res.status).toBe(403);
    });
});

describe('pipeline parity on GET', () => {
    it('the app-wide guard runs and its rejection is no-store', async () => {
        const guard = vi.fn(() => {
            throw new ServerFnError(401, 'sign in first');
        });
        const res = await get('read_fn_00000001', [{ id: 'p1' }], {}, { guard });
        expect(res.status).toBe(401);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(guard).toHaveBeenCalledOnce();
    });

    it('the input validator rejects with a 400 on GET', async () => {
        const validated = serverFn({
            cache: { maxAge: 60 },
            input: {
                '~standard': {
                    version: 1 as const,
                    vendor: 'test',
                    validate: (value: unknown) =>
                        typeof value === 'string'
                            ? { value }
                            : { issues: [{ message: 'expected a string' }] }
                }
            },
            handler: async (_rq, input: string) => input.toUpperCase()
        });
        const ok = await get('v', ['hi'], {}, { resolve: () => validated });
        await expect(ok.json()).resolves.toEqual({ data: 'HI' });
        const bad = await get('v', [42], {}, { resolve: () => validated });
        expect(bad.status).toBe(400);
        expect(bad.headers.get('cache-control')).toBe('no-store');
    });

    it('timeoutMs 504s a hung read, no-store', async () => {
        const hung = serverFn({
            cache: { maxAge: 60 },
            handler: () => new Promise<never>(() => {})
        });
        const onError = vi.fn();
        const res = await get('h', [], {}, { resolve: () => hung, timeoutMs: 20, onError });
        expect(res.status).toBe(504);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('$cache.invalidates is never attached on the GET path', async () => {
        const conflicted = serverFn({
            cache: { maxAge: 60 },
            invalidates: () => [['cart']],
            handler: async () => 'both'
        });
        const res = await get('c', [], {}, { resolve: () => conflicted });
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({ data: 'both' });
        expect('$cache' in body).toBe(false);
    });
});

describe('__DEV__ warnings', () => {
    it('declaring both cache and invalidates warns at definition time', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serverFn({
            cache: { maxAge: 60 },
            invalidates: () => [['cart']],
            handler: async function bothDeclared() {
                return 1;
            }
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('a read that invalidates is not a read'));
    });

    it('a public read touching rq.request warns once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const nosy = serverFn({
            cache: { maxAge: 30, public: true },
            handler: async (rq) => {
                void rq.request.headers.get('cookie');
                void rq.request.url;
                return 'peeked';
            }
        });
        const res = await get('n', [], {}, { resolve: () => nosy });
        expect(res.status).toBe(200);
        const touches = warn.mock.calls.filter(([msg]) =>
            String(msg).includes('touched rq.request')
        );
        expect(touches).toHaveLength(1);
    });

    it('a private read touching rq.request does NOT warn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const personal = serverFn({
            cache: { maxAge: 30 },
            handler: async (rq) => rq.request.headers.get('x-user') ?? 'anon'
        });
        const res = await get('p', [], { headers: { 'x-user': 'andii' } }, { resolve: () => personal });
        await expect(res.json()).resolves.toEqual({ data: 'andii' });
        expect(warn).not.toHaveBeenCalled();
    });
});
