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
        expect(matchesServerFn(req('/_sigx/fn/%40acme%2Fapi%23add'))).toBe(true);
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

    it('honors a custom base, with or without a trailing slash', () => {
        expect(matchesServerFn(req('/rpc/add_fn_00000001'), '/rpc')).toBe(true);
        expect(matchesServerFn(req('/rpc/add_fn_00000001'), '/rpc/')).toBe(true);
        expect(matchesServerFn(req('/_sigx/fn/add_fn_00000001'), '/rpc')).toBe(false);
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
    it('resolves an encoded stable symbol and derives the name after the "#"', async () => {
        const stable = '@acme/api/src/cart.server.ts#addToCart';
        const seen: { symbol: string; name: string }[] = [];
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${encodeURIComponent(stable)}`, {
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
        // resolve received the DECODED symbol; the guard's info.name is the
        // after-# segment, even though the id contains no hashed tail.
        expect(seen).toEqual([{ symbol: stable, name: 'addToCart' }]);
    });

    it('a stable id containing a hashed-looking tail cannot misparse the name', async () => {
        const tricky = 'legacy_fn_00000001/api.server.ts#run';
        const seen: string[] = [];
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${encodeURIComponent(tricky)}`, {
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
        expect(seen).toEqual(['run']); // '#' wins over the _fn_<hex8> pattern
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
});

describe('handleServerFnRequest — pollution reviver', () => {
    it('drops dangerous keys from parsed args', async () => {
        const res = await call('echo_fn_00000004', undefined, {
            body: '{"args":[{"__proto__":{"polluted":true},"ok":1}]}'
        });
        const body = await res.json();
        expect(body.data).toEqual({ ok: 1 });
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});
