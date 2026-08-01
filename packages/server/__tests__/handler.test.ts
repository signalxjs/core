/**
 * @vitest-environment node
 *
 * handleServerFnRequest() — the WinterCG endpoint (rfc-server §4/§5): the
 * status matrix, the guard seam, response-header/status plumbing, error
 * masking, and the prototype-pollution reviver.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    handleServerFnRequest,
    matchesServerFn,
    type ServerFnRequestOptions
} from '../src/server/index';
import { serverFn, ServerFnError } from '../src/index';

const ORIGIN = 'http://localhost';

const add = serverFn(async (_rq, a: number, b: number) => a + b);
const boom = serverFn(async () => {
    throw new Error('secret internals');
});
const politeBoom = serverFn(async () => {
    throw new ServerFnError(418, 'teapot', { hint: 'short and stout' });
});
const echo = serverFn(async (_rq, value: unknown) => value);
const withHeaders = serverFn(async (rq) => {
    rq.responseHeaders.set('x-custom', 'yes');
    rq.status(201);
    return 'created';
});

const FNS: Record<string, unknown> = {
    add_fn_00000001: add,
    boom_fn_00000002: boom,
    polite_fn_00000003: politeBoom,
    echo_fn_00000004: echo,
    headers_fn_00000005: withHeaders
};

function call(
    symbol: string,
    body: unknown,
    init: RequestInit & { headers?: Record<string, string> } = {},
    options: Partial<ServerFnRequestOptions> = {}
): Promise<Response> {
    const request = new Request(`${ORIGIN}/_sigx/fn/${symbol}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            ...init.headers
        },
        ...('body' in init ? { body: init.body } : { body: JSON.stringify(body) }),
        ...(init.method ? { method: init.method } : {})
    });
    return handleServerFnRequest(request, {
        resolve: (sym) => FNS[sym] ?? null,
        ...options
    });
}

describe('matchesServerFn (rfc-deploy §2)', () => {
    const req = (path: string, method = 'POST') => new Request(`${ORIGIN}${path}`, { method });

    it('matches requests under the default base, any method', () => {
        expect(matchesServerFn(req('/_sigx/fn/add_fn_00000001'))).toBe(true);
        expect(matchesServerFn(req('/_sigx/fn/@acme/api/add'))).toBe(true);
        // Method deliberately unchecked — a GET should reach the 405, not
        // fall through to the document handler.
        expect(matchesServerFn(req('/_sigx/fn/add_fn_00000001', 'GET'))).toBe(true);
    });

    it('ignores query strings (pathname match)', () => {
        expect(matchesServerFn(req('/_sigx/fn/add_fn_00000001?trace=1'))).toBe(true);
    });

    it('does not match other paths, the bare base, or prefix look-alikes', () => {
        expect(matchesServerFn(req('/'))).toBe(false);
        expect(matchesServerFn(req('/_sigx/fn'))).toBe(false);          // no symbol segment
        expect(matchesServerFn(req('/_sigx/fnord/x'))).toBe(false);     // not a path segment
        expect(matchesServerFn(req('/api/_sigx/fn/x'))).toBe(false);    // not under the mount
    });

    it('honors a custom base however it is slashed', () => {
        expect(matchesServerFn(req('/rpc/add_fn_00000001'), '/rpc')).toBe(true);
        expect(matchesServerFn(req('/rpc/add_fn_00000001'), '/rpc/')).toBe(true);
        expect(matchesServerFn(req('/rpc/add_fn_00000001'), '/rpc//')).toBe(true);
        expect(matchesServerFn(req('/_sigx/fn/add_fn_00000001'), '/rpc')).toBe(false);
    });
});

describe('base agreement (#563)', () => {
    it('the handler routes a custom base identically however it is slashed', async () => {
        // The invariant `fnPathPrefix` now centralizes: the predicate and the
        // handler derived it independently before, in three copies. `/rpc//`
        // is included because leaving it doubled would put an empty first
        // segment into the symbol `decodeFnPath` splits.
        for (const base of ['/rpc', '/rpc/', '/rpc//']) {
            const request = new Request(`${ORIGIN}/rpc/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({ args: [2, 3] })
            });
            const res = await handleServerFnRequest(request, {
                resolve: (sym) => FNS[sym] ?? null,
                base
            });
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ data: 5 });
        }
    });

    /** A well-formed POST under the DEFAULT base — the mismatch case. */
    const defaultBasePost = (): Request =>
        new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ args: [2, 3] })
        });

    it('a request under a base the handler does not describe is a 404 — and says so in dev', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await handleServerFnRequest(defaultBasePost(), {
                resolve: (sym) => FNS[sym] ?? null,
                base: '/rpc'
            });
            expect(res.status).toBe(404);
            // Silent until #563: a mount the two sites disagree about 404s
            // every call with nothing to point at.
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("does not start with this handler's base")
            );
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('serverFnBase'));
        } finally {
            warn.mockRestore();
        }
    });

    it('the mismatch warning is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await handleServerFnRequest(defaultBasePost(), {
                resolve: (sym) => FNS[sym] ?? null,
                base: '/rpc'
            });
            expect(res.status).toBe(404);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            vi.unstubAllEnvs();
        }
    });
});

describe('handleServerFnRequest — happy path', () => {
    it('invokes the function and returns {data}', async () => {
        const res = await call('add_fn_00000001', { args: [2, 3] });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });

    it('an undefined result returns an empty envelope', async () => {
        const noop = serverFn(async () => undefined);
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/noop`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            { resolve: () => noop }
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({});
    });

    it('applies rq.responseHeaders and rq.status()', async () => {
        const res = await call('headers_fn_00000005', { args: [] });
        expect(res.status).toBe(201);
        expect(res.headers.get('x-custom')).toBe('yes');
        await expect(res.json()).resolves.toEqual({ data: 'created' });
    });

    it('tolerates content-type parameters', async () => {
        const res = await call('add_fn_00000001', { args: [1, 1] }, {
            headers: { 'content-type': 'application/json; charset=utf-8' }
        });
        expect(res.status).toBe(200);
    });
});

describe('handleServerFnRequest — status matrix', () => {
    it('405 + Allow for non-POST', async () => {
        const res = await call('add_fn_00000001', undefined, { method: 'GET', body: undefined as never });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
    });

    it('415 for a missing or wrong content-type', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'text/plain', origin: ORIGIN },
                body: '{"args":[1,2]}'
            }),
            { resolve: (sym) => FNS[sym] }
        );
        expect(res.status).toBe(415);
    });

    it('403 for a missing or cross-origin Origin header (default policy)', async () => {
        const missing = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[1,2]}'
            }),
            { resolve: (sym) => FNS[sym] }
        );
        expect(missing.status).toBe(403);

        const cross = await call('add_fn_00000001', { args: [1, 2] }, {
            headers: { origin: 'https://evil.example' }
        });
        expect(cross.status).toBe(403);
    });

    it('origin allowlist and origin:false override the default', async () => {
        const listed = await call('add_fn_00000001', { args: [1, 2] }, {
            headers: { origin: 'https://app.example' }
        }, { origin: ['https://app.example'] });
        expect(listed.status).toBe(200);

        const open = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[1,2]}'
            }),
            { resolve: (sym) => FNS[sym], origin: false }
        );
        expect(open.status).toBe(200);
    });

    it('404 with an error envelope for an unknown symbol', async () => {
        const res = await call('gone_fn_ffffffff', { args: [] });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toContain('gone_fn_ffffffff');
    });

    it('400 for malformed JSON and for a non-array args', async () => {
        const malformed = await call('add_fn_00000001', undefined, { body: '{not json' });
        expect(malformed.status).toBe(400);
        const notArray = await call('add_fn_00000001', { args: 'nope' });
        expect(notArray.status).toBe(400);
    });

    it('413 when the body exceeds maxBodyBytes', async () => {
        const res = await call('add_fn_00000001', { args: ['x'.repeat(2048)] }, {}, { maxBodyBytes: 1024 });
        expect(res.status).toBe(413);
    });
});

describe('handleServerFnRequest — stable symbols (rfc-server rev 2, N.3)', () => {
    it('reads a multi-segment stable symbol off the path and derives the last segment as the name', async () => {
        const stable = '@acme/api/src/cart.server.ts/addToCart';
        const seen: { symbol: string; name: string }[] = [];
        const url = `${ORIGIN}/_sigx/fn/${stable}`;
        expect(url).not.toContain('%'); // #355: the whole point
        const res = await handleServerFnRequest(
            new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[2,3]}'
            }),
            {
                resolve: (sym) => (sym === stable ? add : null),
                guard: (_rq, fn) => {
                    seen.push(fn);
                }
            }
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 5 });
        // resolve received every segment after the base, rejoined; the
        // guard's info.name is the last one, even though the id carries no
        // hashed tail.
        expect(seen).toEqual([{ symbol: stable, name: 'addToCart' }]);
    });

    it('a stable id containing a hashed-looking tail cannot misparse the name', async () => {
        const tricky = 'legacy_fn_00000001/api.server.ts/run';
        const seen: string[] = [];
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${tricky}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: () => echo,
                guard: (_rq, fn) => {
                    seen.push(fn.name);
                }
            }
        );
        expect(res.status).toBe(200);
        expect(seen).toEqual(['run']); // the last '/' wins over the _fn_<hex8> pattern
    });

    it('decodes a segment that HAD to be escaped', async () => {
        const stable = '@acme/a b/add';
        let got = '';
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/@acme/a%20b/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: (sym) => {
                    got = sym;
                    return echo;
                }
            }
        );
        expect(res.status).toBe(200);
        expect(got).toBe(stable);
    });

    it('the pre-#355 percent-encoded stable route is GONE, not silently aliased', async () => {
        // `<stableId>#<name>` squeezed into one segment. It decodes cleanly —
        // it is simply not a symbol anything registers any more, so a stale
        // native client gets the structured 404 its stub reads as skew.
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/%40acme%2Fapi%2Fsrc%2Fcart.server.ts%23addToCart`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[2,3]}'
            }),
            { resolve: (sym) => (sym === '@acme/api/src/cart.server.ts/addToCart' ? add : null) }
        );
        expect(res.status).toBe(404);
    });

    it('400s a malformed escape instead of throwing into a masked 500', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/%FF`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            { resolve: () => echo }
        );
        expect(res.status).toBe(400);
    });

    it('404s a path outside the configured base rather than guessing a symbol', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/elsewhere/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[1,2]}'
            }),
            { resolve: () => add }
        );
        expect(res.status).toBe(404);
    });

    it('honors a custom base', async () => {
        let got = '';
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/api/rpc/@acme/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                base: '/api/rpc',
                resolve: (sym) => {
                    got = sym;
                    return echo;
                }
            }
        );
        expect(res.status).toBe(200);
        expect(got).toBe('@acme/api/add');
    });

    it('hashed-symbol name derivation is unregressed', async () => {
        const seen: string[] = [];
        await call('add_fn_00000001', { args: [1, 2] }, {}, {
            guard: (_rq, fn) => {
                seen.push(fn.name);
            }
        });
        expect(seen).toEqual(['add']);
    });
});

describe('handleServerFnRequest — origin: verify-when-present (rfc-server rev 2)', () => {
    const noOrigin = (options: Partial<ServerFnRequestOptions>) =>
        handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[1,2]}'
            }),
            { resolve: (sym) => FNS[sym], ...options }
        );

    it('admits a request WITHOUT an Origin header (programmatic client)', async () => {
        const res = await noOrigin({ origin: 'verify-when-present' });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 3 });
    });

    it('still verifies a PRESENT Origin — match passes, mismatch 403s', async () => {
        const match = await call('add_fn_00000001', { args: [1, 2] }, {}, {
            origin: 'verify-when-present'
        });
        expect(match.status).toBe(200);

        const cross = await call('add_fn_00000001', { args: [1, 2] }, {
            headers: { origin: 'https://evil.example' }
        }, { origin: 'verify-when-present' });
        expect(cross.status).toBe(403);
    });

    it('rejects "Origin: null" — a PRESENT header, not an absent one', async () => {
        const res = await call('add_fn_00000001', { args: [1, 2] }, {
            headers: { origin: 'null' }
        }, { origin: 'verify-when-present' });
        expect(res.status).toBe(403);
    });

    it("the default 'same-origin' still rejects an absent Origin", async () => {
        const res = await noOrigin({});
        expect(res.status).toBe(403);
    });
});

describe('handleServerFnRequest — errors', () => {
    it('ServerFnError passes through verbatim', async () => {
        const res = await call('polite_fn_00000003', { args: [] });
        expect(res.status).toBe(418);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'teapot', status: 418, data: { hint: 'short and stout' } }
        });
    });

    it('masks other throws to a generic 500 in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const res = await call('boom_fn_00000002', { args: [] });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error.message).toBe('Internal error');
            expect(JSON.stringify(body)).not.toContain('secret internals');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('includes the message in dev', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await call('boom_fn_00000002', { args: [] });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error.message).toBe('secret internals');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('handleServerFnRequest — throwing resolve (#555)', () => {
    it('a rejecting resolve is a masked 500 in prod, reported to onError with derived info', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const seen: unknown[][] = [];
            const res = await call('broken_fn_00000001', { args: [] }, {}, {
                resolve: async () => {
                    throw new Error('registry import failed: /srv/secret/chunk.js');
                },
                onError: (error, info, ctx) => {
                    seen.push([error, info, ctx]);
                }
            });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body).toEqual({ error: { message: 'Internal error', status: 500 } });
            expect(JSON.stringify(body)).not.toContain('secret');
            expect(seen).toHaveLength(1);
            expect((seen[0][0] as Error).message).toContain('registry import failed');
            // The name is derived from the symbol alone — the fn never resolved.
            expect(seen[0][1]).toMatchObject({ symbol: 'broken_fn_00000001', name: 'broken' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('includes the message in dev', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await call('broken_fn_00000001', { args: [] }, {}, {
                resolve: async () => {
                    throw new Error('ssrLoadModule: syntax error in cart.server.ts');
                }
            });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error.message).toContain('syntax error in cart.server.ts');
        } finally {
            spy.mockRestore();
        }
    });

    it('a synchronously throwing resolve is masked the same way', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const res = await call('broken_fn_00000001', { args: [] }, {}, {
                resolve: () => {
                    throw new Error('sync registry failure');
                }
            });
            expect(res.status).toBe(500);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('a resolve throwing ServerFnError passes through verbatim, no onError', async () => {
        const onError = vi.fn();
        const res = await call('warming_fn_00000001', { args: [] }, {}, {
            resolve: () => {
                throw new ServerFnError(503, 'registry warming');
            },
            onError
        });
        expect(res.status).toBe(503);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'registry warming', status: 503 }
        });
        expect(onError).not.toHaveBeenCalled();
    });

    it('a GET with a rejecting resolve gets the masked 500 with no-store', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const res = await handleServerFnRequest(
                new Request(`${ORIGIN}/_sigx/fn/read_fn_00000001?args=%5B%5D`, { method: 'GET' }),
                {
                    resolve: async () => {
                        throw new Error('chunk missing');
                    }
                }
            );
            expect(res.status).toBe(500);
            expect(res.headers.get('cache-control')).toBe('no-store');
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('a prototype-key symbol against a plain-object registry is a clean 404', async () => {
        // FNS['__proto__'] is Object.prototype — truthy but carrying no
        // __sigxFn, so the unknown-symbol check must catch it.
        const res = await call('__proto__', { args: [] });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toBe('Unknown server function "__proto__"');
    });

    it('a body stream erroring mid-read is a 400, never a masked 500, no onError', async () => {
        const onError = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"args":'));
                controller.error(new Error('connection reset'));
            }
        });
        const request = new Request(`${ORIGIN}/_sigx/fn/add_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body,
            duplex: 'half'
        } as unknown as RequestInit);
        const res = await handleServerFnRequest(request, {
            resolve: (sym) => FNS[sym] ?? null,
            onError
        });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Malformed request body', status: 400 }
        });
        expect(onError).not.toHaveBeenCalled();
    });
});

describe('handleServerFnRequest — guard seam', () => {
    it('runs before the function with the symbol info and shares locals', async () => {
        const seen: unknown[] = [];
        const whoami = serverFn(async (rq) => rq.locals.user);
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/who_fn_00000006`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: () => whoami,
                guard: (rq, fn) => {
                    seen.push(fn.symbol);
                    rq.locals.user = 'andy';
                }
            }
        );
        await expect(res.json()).resolves.toEqual({ data: 'andy' });
        expect(seen).toEqual(['who_fn_00000006']);
    });

    it('a guard veto becomes the response, cookies included', async () => {
        const res = await call('add_fn_00000001', { args: [1, 2] }, {}, {
            guard: (rq) => {
                rq.responseHeaders.set('set-cookie', 'challenge=1');
                throw new ServerFnError(401, 'sign in first');
            }
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toBe('challenge=1');
        await expect(res.json()).resolves.toEqual({
            error: { message: 'sign in first', status: 401 }
        });
    });

    // The standing pin (rfc-server-v3 §5). `guard` lives INSIDE this handler,
    // so it covers the wire transports and nothing else — an in-process
    // (SSR-time) call never enters it. That asymmetry is documented (§4,
    // #493) and deliberate (§1.1: the alternatives all fail open), so it is
    // executable here and a future "fix" cannot change it silently. The
    // transport-independent chain is the definition's `use:` /
    // `serverFnPreset`.
    it('does NOT run for an in-process call — the endpoint guard is wire-only (§1.1/§4)', async () => {
        let guarded = 0;
        const secret = serverFn(async () => 'data');
        const options: Partial<ServerFnRequestOptions> = {
            resolve: () => secret,
            guard: () => {
                guarded += 1;
            }
        };
        // Mounting the handler does not wrap the function: calling it
        // directly, exactly as `useData` does during SSR, bypasses it.
        void options;
        await expect(secret()).resolves.toBe('data');
        expect(guarded).toBe(0);

        // …while the same function over the wire IS guarded, so the test
        // pins the asymmetry rather than just the absence.
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/secret_fn_00000007`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            options as ServerFnRequestOptions
        );
        await expect(res.json()).resolves.toEqual({ data: 'data' });
        expect(guarded).toBe(1);
    });
});

describe('handleServerFnRequest — pollution reviver', () => {
    it('drops an own __proto__ key from parsed args, with a dev warning (#560)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await call('echo_fn_00000004', undefined, {
                body: '{"args":[{"__proto__":{"polluted":true},"ok":1}]}'
            });
            const body = await res.json();
            expect(body.data).toEqual({ ok: 1 });
            expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('__proto__'));
        } finally {
            warn.mockRestore();
        }
    });

    it('"constructor" and "prototype" are plain data keys and SURVIVE (#560)', async () => {
        // Dropping them silently ate legitimate payloads — only __proto__ is
        // a prototype swap under assignment; these are ordinary own props.
        const res = await call('echo_fn_00000004', undefined, {
            body: '{"args":[{"constructor":"Acme Corp","prototype":"blueprint","ok":1}]}'
        });
        const body = await res.json();
        expect(body.data).toEqual({ constructor: 'Acme Corp', prototype: 'blueprint', ok: 1 });
    });

    // The parse skips the reviver when the source cannot SPELL a dangerous
    // key (#544). A `\u` escape spells one without the literal ever appearing,
    // so a substring-only prescan would wave it through.
    //
    // Asserting on the RESPONSE would not catch that. `reviveWire` rebuilds
    // objects with plain assignment, and `out.__proto__ = value` sets the
    // prototype instead of creating an own property — the key vanishes from
    // the response while the argument object the handler receives carries an
    // attacker-supplied prototype. So these assert on what the FUNCTION SEES.
    const captor = (): { fn: unknown; seen: () => Record<string, unknown> } => {
        let captured: Record<string, unknown> = {};
        return {
            fn: serverFn(async (_rq, value: Record<string, unknown>) => {
                captured = value;
                return 'ok';
            }),
            seen: () => captured
        };
    };

    it('drops __proto__ spelled with \\u escapes, before it reaches the handler', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { fn, seen } = captor();
            const res = await call('capture_fn_00000006', undefined, {
                body: '{"args":[{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true},"ok":1}]}'
            }, { resolve: () => fn });

            expect(res.status).toBe(200);
            const input = seen();
            expect(input).toEqual({ ok: 1 });
            // The load-bearing one: a naive prescan leaves this pointing at
            // {"polluted": true} rather than Object.prototype.
            expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
            expect((input as { polluted?: boolean }).polluted).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('__proto__'));
        } finally {
            warn.mockRestore();
        }
    });

    it('"constructor"/"prototype" spelled with \\u escapes survive as data (#560)', async () => {
        const { fn, seen } = captor();
        const res = await call('capture_fn_00000006', undefined, {
            body:
                '{"args":[{"\\u0063onstructor":{"a":1},' +
                '"\\u0070rototype":{"b":2},"ok":1}]}'
        }, { resolve: () => fn });

        expect(res.status).toBe(200);
        const input = seen();
        expect(input).toEqual({ constructor: { a: 1 }, prototype: { b: 2 }, ok: 1 });
        expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    });

    it('leaves a body that merely MENTIONS a dangerous name in a value alone', async () => {
        const { fn, seen } = captor();
        await call('capture_fn_00000006', undefined, {
            body: '{"args":[{"note":"see the constructor docs","ok":1}]}'
        }, { resolve: () => fn });

        expect(seen()).toEqual({ note: 'see the constructor docs', ok: 1 });
    });
});

describe('handleServerFnRequest — onError observability seam (#349)', () => {
    it('fires for a masked throw in production, before the response, with (error, info, ctx)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const seen: unknown[][] = [];
            const res = await call('boom_fn_00000002', { args: [] }, {}, {
                onError: (error, info, ctx) => {
                    seen.push([error, info, ctx]);
                }
            });
            expect(res.status).toBe(500);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
            expect(seen).toHaveLength(1);
            expect((seen[0][0] as Error).message).toBe('secret internals');
            expect(seen[0][1]).toMatchObject({ symbol: 'boom_fn_00000002', name: 'boom' });
            expect(seen[0][2]).toMatchObject({ locals: {} });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('fires in dev too', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const onError = vi.fn();
        await call('boom_fn_00000002', { args: [] }, {}, { onError });
        expect(onError).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('does NOT fire for a ServerFnError (expected, client-visible)', async () => {
        const onError = vi.fn();
        const res = await call('polite_fn_00000003', { args: [] }, {}, { onError });
        expect(res.status).toBe(418);
        expect(onError).not.toHaveBeenCalled();
    });

    it('is awaited (async work completes before the response returns)', async () => {
        let flag = false;
        await call('boom_fn_00000002', { args: [] }, {}, {
            onError: async () => {
                await new Promise((r) => setTimeout(r, 5));
                flag = true;
            }
        });
        expect(flag).toBe(true);
    });

    it('its own throws are swallowed — response unchanged', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const res = await call('boom_fn_00000002', { args: [] }, {}, {
                onError: () => {
                    throw new Error('telemetry down');
                }
            });
            expect(res.status).toBe(500);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
            const rejected = await call('boom_fn_00000002', { args: [] }, {}, {
                onError: async () => Promise.reject(new Error('async telemetry down'))
            });
            expect(rejected.status).toBe(500);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('fires for masked GUARD throws too', async () => {
        const onError = vi.fn();
        const res = await call('add_fn_00000001', { args: [1, 2] }, {}, {
            onError,
            guard: () => {
                throw new Error('guard exploded');
            }
        });
        expect(res.status).toBe(500);
        expect(onError).toHaveBeenCalledTimes(1);
    });
});

describe('handleServerFnRequest — timeoutMs (#350)', () => {
    const hang = serverFn(async (rq) => {
        await new Promise<void>((resolve) => {
            // Resolves only via abort — a cooperative hung handler.
            rq.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'aborted-cleanly';
    });
    const never = serverFn(async () => new Promise(() => {}));
    FNS['hang_fn_00000006'] = hang;
    FNS['never_fn_00000007'] = never;

    it('a hung handler gets a 504 and onError receives the timeout error', async () => {
        const onError = vi.fn();
        const res = await call('never_fn_00000007', { args: [] }, {}, { timeoutMs: 25, onError });
        expect(res.status).toBe(504);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Server function timed out', status: 504 }
        });
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toContain('timed out after 25ms');
    });

    it('rq.abortSignal fires on timeout (cooperative handlers cancel cleanly)', async () => {
        const res = await call('hang_fn_00000006', { args: [] }, {}, { timeoutMs: 25 });
        // The race wins with the 504 even though the handler then resolves.
        expect(res.status).toBe(504);
    });

    it('a fast handler under a generous timeout is unaffected', async () => {
        const res = await call('add_fn_00000001', { args: [2, 3] }, {}, { timeoutMs: 5000 });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });

    it('absent timeoutMs keeps the exact current behavior', async () => {
        const res = await call('add_fn_00000001', { args: [2, 3] });
        expect(res.status).toBe(200);
    });
});

describe('handleServerFnRequest — rich wire serialization (rfc-server §4)', () => {
    class Basket {
        items = 3;
    }
    const returnsDate = serverFn(async () => ({ createdAt: new Date(1_700_000_000_000) }));
    const returnsMap = serverFn(async () => new Map([['a', 1]]));
    const returnsNestedUndefined = serverFn(async () => ({ a: { b: undefined } }));
    const returnsInstance = serverFn(async () => new Basket());
    const returnsToJson = serverFn(async () => ({ range: { toJSON: () => [1, 2] } }));
    const returnsPlain = serverFn(async () => ({ ok: [1, 2, { deep: true }] }));
    const returnsRich = serverFn(async () => ({
        at: new Date(5),
        tags: new Set(['a']),
        total: 42n,
        home: new URL('https://example.com/'),
        pattern: /ab+c/gi
    }));
    const returnsTagLike = serverFn(async () => ({ $date: 'just a string' }));
    const echoes = serverFn(async (_rq, value: unknown) => value);
    const returnsCircular = serverFn(async () => {
        const c: Record<string, unknown> = { a: 1 };
        c.self = c;
        return c;
    });
    Object.assign(FNS, {
        date_fn_00000008: returnsDate,
        map_fn_00000009: returnsMap,
        undef_fn_0000000a: returnsNestedUndefined,
        inst_fn_0000000b: returnsInstance,
        tojson_fn_0000000c: returnsToJson,
        plain_fn_0000000d: returnsPlain,
        rich_fn_0000000e: returnsRich,
        taglike_fn_0000000f: returnsTagLike,
        echo_fn_00000010: echoes,
        circular_fn_00000011: returnsCircular
    });

    const dataOf = async (symbol: string, args: unknown[] = []): Promise<unknown> =>
        ((await (await call(symbol, { args })).json()) as { data?: unknown }).data;

    it('tags a Date instead of flattening it to a string', async () => {
        expect(await dataOf('date_fn_00000008')).toEqual({
            createdAt: { $date: 1_700_000_000_000 }
        });
    });

    it('tags a Map instead of emitting {}', async () => {
        expect(await dataOf('map_fn_00000009')).toEqual({ $map: [['a', 1]] });
    });

    it('keeps a nested undefined property instead of dropping it', async () => {
        expect(await dataOf('undef_fn_0000000a')).toEqual({ a: { b: { $undef: 0 } } });
    });

    it('covers every built-in tag in one payload', async () => {
        expect(await dataOf('rich_fn_0000000e')).toEqual({
            at: { $date: 5 },
            tags: { $set: ['a'] },
            total: { $bigint: '42' },
            home: { $url: 'https://example.com/' },
            pattern: { $regexp: ['ab+c', 'gi'] }
        });
    });

    it('escapes a user object that would be mistaken for a tag', async () => {
        expect(await dataOf('taglike_fn_0000000f')).toEqual({
            $esc: { $date: 'just a string' }
        });
    });

    it('still flattens a class instance and honors toJSON', async () => {
        // Prototypes are NOT recovered — a class instance needs a registered
        // handler, which is what the registry seam is for.
        expect(await dataOf('inst_fn_0000000b')).toEqual({ items: 3 });
        expect(await dataOf('tojson_fn_0000000c')).toEqual({ range: [1, 2] });
    });

    it('leaves plain JSON-safe data byte-identical', async () => {
        expect(await dataOf('plain_fn_0000000d')).toEqual({ ok: [1, 2, { deep: true }] });
    });

    it('decodes rich types in ARGUMENTS, not just results', async () => {
        // The direction that had no coverage at all before §4 landed.
        const echoed = await dataOf('echo_fn_00000010', [{ $date: 5 }]);
        expect(echoed).toEqual({ $date: 5 });
    });

    it('revives an argument into a live instance for the handler', async () => {
        let seen: unknown;
        Object.assign(FNS, {
            seen_fn_00000012: serverFn(async (_rq, v: unknown) => {
                seen = v;
                return null;
            })
        });
        await call('seen_fn_00000012', { args: [{ $map: [['k', { $date: 1 }]] }] });
        expect(seen).toBeInstanceOf(Map);
        expect((seen as Map<string, unknown>).get('k')).toBeInstanceOf(Date);
    });

    it('rejects a malformed encoded argument as a 400, not a 500', async () => {
        const res = await call('echo_fn_00000010', { args: [{ $bigint: 'not a number' }] });
        expect(res.status).toBe(400);
    });

    it('still fails on a circular result — the one unsupported shape', async () => {
        const res = await call('circular_fn_00000011', { args: [] });
        expect(res.status).toBe(500);
    });

    it('the guard runs BEFORE wire revive — a veto beats a malformed encoded arg (#559)', async () => {
        // The codec's revive handlers do attacker-directed work (BigInt digit
        // conversion, RegExp compilation), so an unvetted request must never
        // reach them: the guard's 401 wins over the reviver's 400.
        const res = await call('echo_fn_00000010', { args: [{ $bigint: 'not a number' }] }, {}, {
            guard: (rq) => {
                rq.responseHeaders.set('set-cookie', 'challenge=1');
                throw new ServerFnError(401, 'sign in first');
            }
        });
        expect(res.status).toBe(401);
        // And the #557 rule holds on the post-guard revive 400 too:
        const reject = await call('echo_fn_00000010', { args: [{ $bigint: 'not a number' }] }, {}, {
            guard: (rq) => {
                rq.responseHeaders.set('set-cookie', 'trace=1');
            }
        });
        expect(reject.status).toBe(400);
        expect(reject.headers.get('set-cookie')).toBe('trace=1');
    });

    it('a body nesting past the codec depth cap is a clean 400 (#559)', async () => {
        const body = `{"args":[${'{"child":'.repeat(300)}1${'}'.repeat(300)}]}`;
        const res = await call('echo_fn_00000010', undefined, { body });
        expect(res.status).toBe(400);
        const parsed = await res.json();
        expect(parsed.error.message).toBe('Malformed encoded value in body');
    });
});

describe('handleServerFnRequest — direct-form wire-args warning (#412)', () => {
    it('a direct-form fn behind the endpoint warns once across repeated POSTs', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fn = serverFn(async (_rq, id: string) => id);
            await call('direct_fn_00000013', { args: ['a'] }, {}, { resolve: () => fn });
            await call('direct_fn_00000013', { args: ['b'] }, {}, { resolve: () => fn });
            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('"direct"'));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('no declared input validator'));
        } finally {
            warn.mockRestore();
        }
    });
});
