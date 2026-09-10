/**
 * @vitest-environment node
 *
 * handleServerFnRequest() — the WinterCG endpoint (rfc-server §4/§5): the
 * status matrix, the guard seam, response-header/status plumbing, error
 * masking, the prototype-pollution reviver, and the `functions` registry
 * path with its version-skew 409 (rfc-server-v5 §1.6/§3.2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    handleServerFnRequest,
    matchesServerFn,
    type ServerFnRequestOptions
} from '../src/server/index';
import {
    serverFn,
    ServerFnError,
    type ServerFnRegistry,
    type ServerFnRegistryEntry
} from '../src/index';
import { stubServerApp } from '../src/testing';

// The endpoint now runs the app pipeline's wire half (middleware →
// authenticate → identity gate) before decoding; these tests are about the
// ENDPOINT's own behavior, so an authenticated app makes the pipeline
// transparent. The pipeline itself is pinned in app-pipeline.test.ts.
let restoreApp: () => void;
beforeEach(() => {
    restoreApp = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
});
afterEach(() => {
    restoreApp();
});

const ORIGIN = 'http://localhost';

// One tuple input — a server function takes a single input (rfc-server-v5
// §1.2), so the wire body is `{"args":[[a, b]]}`.
const add = serverFn({
    handler: async ({ input: [a, b] }: { input: [number, number] }) => a + b
});
const boom = serverFn({
    handler: async () => {
        throw new Error('secret internals');
    }
});
const politeBoom = serverFn({
    handler: async () => {
        throw new ServerFnError(418, 'teapot', { hint: 'short and stout' });
    }
});
const echo = serverFn({ handler: async ({ input: value }: { input: unknown }) => value });
const withHeaders = serverFn({
    handler: async ({ rq }) => {
        rq.responseHeaders.set('x-custom', 'yes');
        rq.status(201);
        return 'created';
    }
});

// Keys are `<id>/<name>` (rfc-server-v5 §1.3) — the only identity a server
// function has now; the endpoint derives `info.name` from the last segment.
const FNS: Record<string, unknown> = {
    'api/add': add,
    'api/boom': boom,
    'api/polite': politeBoom,
    'api/echo': echo,
    'api/headers': withHeaders
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
        expect(matchesServerFn(req('/_sigx/fn/api/add'))).toBe(true);
        expect(matchesServerFn(req('/_sigx/fn/@acme/api/add'))).toBe(true);
        // Method deliberately unchecked — a GET should reach the 405, not
        // fall through to the document handler.
        expect(matchesServerFn(req('/_sigx/fn/api/add', 'GET'))).toBe(true);
    });

    it('ignores query strings (pathname match)', () => {
        expect(matchesServerFn(req('/_sigx/fn/api/add?trace=1'))).toBe(true);
    });

    it('does not match other paths, the bare base, or prefix look-alikes', () => {
        expect(matchesServerFn(req('/'))).toBe(false);
        expect(matchesServerFn(req('/_sigx/fn'))).toBe(false);          // no symbol segment
        expect(matchesServerFn(req('/_sigx/fnord/x'))).toBe(false);     // not a path segment
        expect(matchesServerFn(req('/api/_sigx/fn/x'))).toBe(false);    // not under the mount
    });

    it('honors a custom base however it is slashed', () => {
        expect(matchesServerFn(req('/rpc/api/add'), '/rpc')).toBe(true);
        expect(matchesServerFn(req('/rpc/api/add'), '/rpc/')).toBe(true);
        expect(matchesServerFn(req('/rpc/api/add'), '/rpc//')).toBe(true);
        expect(matchesServerFn(req('/_sigx/fn/api/add'), '/rpc')).toBe(false);
    });
});

describe('base agreement (#563)', () => {
    it('the handler routes a custom base identically however it is slashed', async () => {
        // The invariant `fnPathPrefix` now centralizes: the predicate and the
        // handler derived it independently before, in three copies. `/rpc//`
        // is included because leaving it doubled would put an empty first
        // segment into the symbol `decodeFnPath` splits.
        for (const base of ['/rpc', '/rpc/', '/rpc//']) {
            const request = new Request(`${ORIGIN}/rpc/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({ args: [[2, 3]] })
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
        new Request(`${ORIGIN}/_sigx/fn/api/add`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ args: [[2, 3]] })
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
        const res = await call('api/add', { args: [[2, 3]] });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });

    it('an undefined result returns an empty envelope', async () => {
        const noop = serverFn({ handler: async () => undefined });
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
        const res = await call('api/headers', { args: [] });
        expect(res.status).toBe(201);
        expect(res.headers.get('x-custom')).toBe('yes');
        await expect(res.json()).resolves.toEqual({ data: 'created' });
    });

    it('tolerates content-type parameters', async () => {
        const res = await call('api/add', { args: [[1, 1]] }, {
            headers: { 'content-type': 'application/json; charset=utf-8' }
        });
        expect(res.status).toBe(200);
    });
});

describe('handleServerFnRequest — status matrix', () => {
    it('405 + Allow for non-POST', async () => {
        const res = await call('api/add', undefined, { method: 'GET', body: undefined as never });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
    });

    it('415 for a missing or wrong content-type', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'text/plain', origin: ORIGIN },
                body: '{"args":[[1,2]]}'
            }),
            { resolve: (sym) => FNS[sym] }
        );
        expect(res.status).toBe(415);
    });

    it('403 for a missing or cross-origin Origin header (default policy)', async () => {
        const missing = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[[1,2]]}'
            }),
            { resolve: (sym) => FNS[sym] }
        );
        expect(missing.status).toBe(403);

        const cross = await call('api/add', { args: [[1, 2]] }, {
            headers: { origin: 'https://evil.example' }
        });
        expect(cross.status).toBe(403);
    });

    it('origin allowlist and origin:false override the default', async () => {
        const listed = await call('api/add', { args: [[1, 2]] }, {
            headers: { origin: 'https://app.example' }
        }, { origin: ['https://app.example'] });
        expect(listed.status).toBe(200);

        const open = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[[1,2]]}'
            }),
            { resolve: (sym) => FNS[sym], origin: false }
        );
        expect(open.status).toBe(200);
    });

    it('404 with an error envelope for an unknown symbol', async () => {
        const res = await call('api/gone', { args: [] });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toContain('api/gone');
    });

    it('400 for malformed JSON and for a non-array args', async () => {
        const malformed = await call('api/add', undefined, { body: '{not json' });
        expect(malformed.status).toBe(400);
        const notArray = await call('api/add', { args: 'nope' });
        expect(notArray.status).toBe(400);
    });

    it('413 when the body exceeds maxBodyBytes', async () => {
        const res = await call('api/add', { args: ['x'.repeat(2048)] }, {}, { maxBodyBytes: 1024 });
        expect(res.status).toBe(413);
    });
});

describe('handleServerFnRequest — stable symbols (rfc-server rev 2, N.3)', () => {
    it('reads a multi-segment stable symbol off the path and derives the last segment as the name', async () => {
        const stable = '@acme/api/src/cart.server.ts/addToCart';
        const seen: { symbol: string; name: string }[] = [];
        // App middleware is where fn info is observed now (the endpoint
        // `guard` option is gone — rfc-server-v4 §3.1).
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    seen.push(fn);
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const url = `${ORIGIN}/_sigx/fn/${stable}`;
        expect(url).not.toContain('%'); // #355: the whole point
        const res = await handleServerFnRequest(
            new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[[2,3]]}'
            }),
            { resolve: (sym) => (sym === stable ? add : null) }
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 5 });
        // resolve received every segment after the base, rejoined; the
        // middleware's info.name is the last one.
        expect(seen).toEqual([{ symbol: stable, name: 'addToCart', transport: 'wire' }]);
    });

    it('a segment that looks like the retired `<name>_fn_<hex8>` symbol is plain text — the last "/" names the fn', async () => {
        const tricky = 'legacy_fn_00000001/api.server.ts/run';
        const seen: string[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    seen.push(fn.name);
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${tricky}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            { resolve: () => echo }
        );
        expect(res.status).toBe(200);
        expect(seen).toEqual(['run']); // the last '/' wins; `_fn_<hex8>` means nothing any more
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
                body: '{"args":[[2,3]]}'
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
            new Request(`${ORIGIN}/elsewhere/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[[1,2]]}'
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

    it('a slash-free key names the whole key; a two-segment key names its tail', async () => {
        const seen: { symbol: string; name: string }[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    seen.push({ symbol: fn.symbol, name: fn.name });
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        // A `resolve`-path key with no separator: nothing to strip, so the
        // name IS the key (the retired `_fn_<hex8>` tail is not recognised).
        await call('add_fn_00000001', { args: [[1, 2]] }, {}, { resolve: () => add });
        await call('api/add', { args: [[1, 2]] });
        expect(seen).toEqual([
            { symbol: 'add_fn_00000001', name: 'add_fn_00000001' },
            { symbol: 'api/add', name: 'add' }
        ]);
    });

    it("the name is the key's last segment", async () => {
        const seen: string[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    seen.push(fn.name);
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        await call('api/add', { args: [[1, 2]] });
        expect(seen).toEqual(['add']);
    });
});

describe('handleServerFnRequest — origin: verify-when-present (rfc-server rev 2)', () => {
    const noOrigin = (options: Partial<ServerFnRequestOptions>) =>
        handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[[1,2]]}'
            }),
            { resolve: (sym) => FNS[sym], ...options }
        );

    it('admits a request WITHOUT an Origin header (programmatic client)', async () => {
        const res = await noOrigin({ origin: 'verify-when-present' });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 3 });
    });

    it('still verifies a PRESENT Origin — match passes, mismatch 403s', async () => {
        const match = await call('api/add', { args: [[1, 2]] }, {}, {
            origin: 'verify-when-present'
        });
        expect(match.status).toBe(200);

        const cross = await call('api/add', { args: [[1, 2]] }, {
            headers: { origin: 'https://evil.example' }
        }, { origin: 'verify-when-present' });
        expect(cross.status).toBe(403);
    });

    it('rejects "Origin: null" — a PRESENT header, not an absent one', async () => {
        const res = await call('api/add', { args: [[1, 2]] }, {
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
        const res = await call('api/polite', { args: [] });
        expect(res.status).toBe(418);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'teapot', status: 418, data: { hint: 'short and stout' } }
        });
    });

    it('masks other throws to a generic 500 in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const res = await call('api/boom', { args: [] });
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
            const res = await call('api/boom', { args: [] });
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
            const res = await call('api/broken', { args: [] }, {}, {
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
            expect(seen[0][1]).toMatchObject({ symbol: 'api/broken', name: 'broken' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('includes the message in dev', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await call('api/broken', { args: [] }, {}, {
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
            const res = await call('api/broken', { args: [] }, {}, {
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
        const res = await call('api/warming', { args: [] }, {}, {
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
                new Request(`${ORIGIN}/_sigx/fn/api/read?args=%5B%5D`, { method: 'GET' }),
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

    it('a prototype-key symbol against a plain-object `resolve` map is a clean 404', async () => {
        // FNS['__proto__'] is Object.prototype — truthy but carrying no
        // __sigx descriptor, so the unknown-symbol check must catch it.
        // (The `functions` path has its own own-property guard — see the
        // registry describe below.)
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
        const request = new Request(`${ORIGIN}/_sigx/fn/api/add`, {
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

describe('handleServerFnRequest — the `functions` registry (rfc-server-v5 §1.6/§3.2)', () => {
    // A cache-marked read so the GET side of the skew check is reachable;
    // `add` covers POST. Both entries carry the build's version tag exactly
    // as `virtual:sigx-server-fns` emits them.
    const double = serverFn({
        cache: { maxAge: 60 },
        handler: async ({ input: n }: { input: number }) => n * 2
    });
    const registry: ServerFnRegistry = {
        'api/add': { version: 'v1', load: async () => add },
        'api/double': { version: 'v1', load: async () => double }
    };
    const SKEW = { error: { message: 'version skew', status: 409, code: 'version-skew' } };

    const post = (
        key: string,
        body: string,
        options: Partial<ServerFnRequestOptions> = { functions: registry }
    ): Promise<Response> =>
        handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${key}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body
            }),
            options
        );
    const get = (
        key: string,
        query: string,
        options: Partial<ServerFnRequestOptions> = { functions: registry }
    ): Promise<Response> =>
        handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/${key}${query}`, { method: 'GET' }),
            options
        );

    it("resolves a key through the entry's load() and serves the call", async () => {
        const res = await post('api/add', '{"args":[[2,3]]}');
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });

    it('a rejecting load() is the masked 500 with the key-derived info (#555/§5)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const seen: unknown[] = [];
            const res = await post('api/broken', '{"args":[]}', {
                functions: {
                    'api/broken': {
                        version: 'v1',
                        load: async () => {
                            throw new Error('chunk missing after partial deploy');
                        }
                    }
                },
                onError: (_error, info) => void seen.push(info)
            });
            expect(res.status).toBe(500);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
            expect(seen).toEqual([{ symbol: 'api/broken', name: 'broken', transport: 'wire' }]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('prototype keys against the registry are structured 404s — the guard lives in the resolver', async () => {
        for (const key of ['__proto__', 'constructor', 'hasOwnProperty']) {
            const res = await post(key, '{"args":[]}');
            expect(res.status).toBe(404);
            await expect(res.json()).resolves.toEqual({
                error: { message: `Unknown server function "${key}"`, status: 404 }
            });
        }
    });

    it('a registry entry that is not `{ load }` is an unknown function, not a TypeError', async () => {
        // Hand-written registries drift; a bare fn where an entry belongs
        // must 404 like any miss rather than throw into a masked 500.
        const res = await post('api/add', '{"args":[[1,2]]}', {
            functions: { 'api/add': add as unknown as ServerFnRegistryEntry }
        });
        expect(res.status).toBe(404);
    });

    it('both `functions` and `resolve` throws — one route table, one source of truth', async () => {
        await expect(
            post('api/add', '{"args":[[1,2]]}', { functions: registry, resolve: () => add })
        ).rejects.toThrow(/EITHER `functions` OR `resolve`/);
    });

    it('a null `functions` is absent, and a non-object one is rejected — both at construction', async () => {
        // A JSON-shaped config or a missed optional import hands over null;
        // it must read as "not provided", never pass the exactly-one gate
        // and then throw inside the own-property check on the first request.
        await expect(post('api/add', '{"args":[[1,2]]}', { functions: null as never })).rejects.toThrow(
            /pass `functions`/
        );
        await expect(post('api/add', '{"args":[[1,2]]}', { functions: 'nope' as never })).rejects.toThrow(
            /must be the registry object/
        );
        // …and a mis-typed `resolve` (a JS caller's `resolve: 0`) is refused
        // the same way, never falling through to the registry path.
        await expect(post('api/add', '{"args":[[1,2]]}', { resolve: 0 as never })).rejects.toThrow(
            /`resolve` must be a function/
        );
    });

    it('neither `functions` nor `resolve` throws — the endpoint refuses to boot blind', async () => {
        await expect(post('api/add', '{"args":[[1,2]]}', {})).rejects.toThrow(/pass `functions`/);
    });

    it('middleware sees the key as info.symbol and its last segment as info.name', async () => {
        const seen: unknown[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    seen.push(fn);
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await post('api/add', '{"args":[[1,2]]}');
        expect(res.status).toBe(200);
        expect(seen).toEqual([{ symbol: 'api/add', name: 'add', transport: 'wire' }]);
    });

    describe('version skew (§3.2)', () => {
        it("a POST whose `v` differs from the entry's version is a 409 version-skew envelope", async () => {
            const res = await post('api/add', '{"args":[[1,2]],"v":"other"}');
            expect(res.status).toBe(409);
            expect(res.headers.get('content-type')).toBe('application/json');
            await expect(res.json()).resolves.toEqual(SKEW);
        });

        it('a GET whose `v` differs is a 409 with no-store — a CDN must not cache the skew', async () => {
            const res = await get('api/double', '?a0=1&v=other');
            expect(res.status).toBe(409);
            expect(res.headers.get('cache-control')).toBe('no-store');
            await expect(res.json()).resolves.toEqual(SKEW);
        });

        it('the 409 wins BEFORE the handler runs', async () => {
            let ran = 0;
            const counted = serverFn({
                handler: async () => {
                    ran += 1;
                    return 'ran';
                }
            });
            const res = await post('api/counted', '{"args":[],"v":"other"}', {
                functions: { 'api/counted': { version: 'v1', load: async () => counted } }
            });
            expect(res.status).toBe(409);
            expect(ran).toBe(0);
        });

        it('served when `v` matches the entry — POST and GET', async () => {
            const posted = await post('api/add', '{"args":[[2,3]],"v":"v1"}');
            expect(posted.status).toBe(200);
            await expect(posted.json()).resolves.toEqual({ data: 5 });
            const got = await get('api/double', '?a0=21&v=v1');
            expect(got.status).toBe(200);
            await expect(got.json()).resolves.toEqual({ data: 42 });
        });

        it('served when `v` is absent — a native client or curl is never skew-checked', async () => {
            const posted = await post('api/add', '{"args":[[2,3]]}');
            expect(posted.status).toBe(200);
            const got = await get('api/double', '?a0=4');
            expect(got.status).toBe(200);
            await expect(got.json()).resolves.toEqual({ data: 8 });
        });

        it('served when the entry carries no version — nothing to compare against', async () => {
            // The type requires a tag (the build always emits one); a
            // hand-rolled registry without it simply opts out of the check.
            const untagged = { load: async () => add } as ServerFnRegistryEntry;
            const res = await post('api/add', '{"args":[[2,3]],"v":"other"}', {
                functions: { 'api/add': untagged }
            });
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ data: 5 });
        });

        it('served through the `resolve` escape hatch even with a wrong `v` — no version is known there', async () => {
            const res = await post('api/add', '{"args":[[2,3]],"v":"other"}', {
                resolve: (key) => FNS[key] ?? null
            });
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ data: 5 });
        });

        it('a non-string `v` is ignored, not a 400 and not a 409', async () => {
            const numeric = await post('api/add', '{"args":[[2,3]],"v":1}');
            expect(numeric.status).toBe(200);
            await expect(numeric.json()).resolves.toEqual({ data: 5 });
            const nested = await post('api/add', '{"args":[[2,3]],"v":{"tag":"other"}}');
            expect(nested.status).toBe(200);
        });
    });
});

describe('handleServerFnRequest — app middleware at the endpoint', () => {
    it('runs before the function with the symbol info and shares locals', async () => {
        const seen: unknown[] = [];
        const whoami = serverFn({ handler: async ({ rq }) => rq.locals.user });
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (rq, fn) => {
                    seen.push(fn.symbol);
                    rq.locals.user = 'andy';
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/whoami`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            { resolve: () => whoami }
        );
        await expect(res.json()).resolves.toEqual({ data: 'andy' });
        expect(seen).toEqual(['api/whoami']);
    });

    it('a middleware veto becomes the response, cookies included', async () => {
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (rq) => {
                    rq.responseHeaders.set('set-cookie', 'challenge=1');
                    throw new ServerFnError(401, 'sign in first');
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await call('api/add', { args: [[1, 2]] });
        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toBe('challenge=1');
        await expect(res.json()).resolves.toEqual({
            error: { message: 'sign in first', status: 401 }
        });
    });

    // The endpoint `guard` option this describe used to pin ("wire-only,
    // does NOT run in-process") is GONE (rfc-server-v4 §3.1) — its
    // replacement is transport-COMPLETE by design, so the pin inverts: ONE
    // middleware covers the in-process call AND the wire call of the same
    // function. The pipeline-order pins live in app-pipeline.test.ts; this
    // one pins completeness at the endpoint boundary specifically.
    it('one app middleware covers BOTH the in-process call and the wire call (§3.1)', async () => {
        let ran = 0;
        const transports: string[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    ran += 1;
                    transports.push(fn.transport);
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const secret = serverFn({ handler: async () => 'data' });

        // In-process, exactly as `useData` does during SSR: covered.
        await expect(secret()).resolves.toBe('data');
        expect(ran).toBe(1);

        // The same function over the wire: covered by the SAME middleware,
        // exactly once (the endpoint runs the prelude; invoke does not
        // re-run it for wire calls — the ownership contract).
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/api/secret`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            { resolve: () => secret }
        );
        await expect(res.json()).resolves.toEqual({ data: 'data' });
        expect(ran).toBe(2);
        expect(transports).toEqual(['in-process', 'wire']);
    });
});

describe('handleServerFnRequest — pollution reviver', () => {
    it('drops an own __proto__ key from parsed args, with a dev warning (#560)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await call('api/echo', undefined, {
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
        const res = await call('api/echo', undefined, {
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
            fn: serverFn({
                handler: async ({ input: value }: { input: Record<string, unknown> }) => {
                    captured = value;
                    return 'ok';
                }
            }),
            seen: () => captured
        };
    };

    it('drops __proto__ spelled with \\u escapes, before it reaches the handler', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { fn, seen } = captor();
            const res = await call('api/capture', undefined, {
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
        const res = await call('api/capture', undefined, {
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
        await call('api/capture', undefined, {
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
            const res = await call('api/boom', { args: [] }, {}, {
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
            expect(seen[0][1]).toMatchObject({ symbol: 'api/boom', name: 'boom' });
            expect(seen[0][2]).toMatchObject({ locals: {} });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('fires in dev too', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const onError = vi.fn();
        await call('api/boom', { args: [] }, {}, { onError });
        expect(onError).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('does NOT fire for a ServerFnError (expected, client-visible)', async () => {
        const onError = vi.fn();
        const res = await call('api/polite', { args: [] }, {}, { onError });
        expect(res.status).toBe(418);
        expect(onError).not.toHaveBeenCalled();
    });

    it('is awaited (async work completes before the response returns)', async () => {
        let flag = false;
        await call('api/boom', { args: [] }, {}, {
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
            const res = await call('api/boom', { args: [] }, {}, {
                onError: () => {
                    throw new Error('telemetry down');
                }
            });
            expect(res.status).toBe(500);
            await expect(res.json()).resolves.toEqual({
                error: { message: 'Internal error', status: 500 }
            });
            const rejected = await call('api/boom', { args: [] }, {}, {
                onError: async () => Promise.reject(new Error('async telemetry down'))
            });
            expect(rejected.status).toBe(500);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('fires for masked MIDDLEWARE throws too', async () => {
        const onError = vi.fn();
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                () => {
                    throw new Error('middleware exploded');
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await call('api/add', { args: [[1, 2]] }, {}, { onError });
        expect(res.status).toBe(500);
        expect(onError).toHaveBeenCalledTimes(1);
    });
});

describe('handleServerFnRequest — timeoutMs (#350)', () => {
    const hang = serverFn({
        handler: async ({ rq }) => {
            await new Promise<void>((resolve) => {
                // Resolves only via abort — a cooperative hung handler.
                rq.abortSignal.addEventListener('abort', () => resolve(), { once: true });
            });
            return 'aborted-cleanly';
        }
    });
    const never = serverFn({ handler: async () => new Promise(() => {}) });
    FNS['api/hang'] = hang;
    FNS['api/never'] = never;

    it('a hung handler gets a 504 and onError receives the timeout error', async () => {
        const onError = vi.fn();
        const res = await call('api/never', { args: [] }, {}, { timeoutMs: 25, onError });
        expect(res.status).toBe(504);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Server function timed out', status: 504 }
        });
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toContain('timed out after 25ms');
    });

    it('rq.abortSignal fires on timeout (cooperative handlers cancel cleanly)', async () => {
        const res = await call('api/hang', { args: [] }, {}, { timeoutMs: 25 });
        // The race wins with the 504 even though the handler then resolves.
        expect(res.status).toBe(504);
    });

    it('a fast handler under a generous timeout is unaffected', async () => {
        const res = await call('api/add', { args: [[2, 3]] }, {}, { timeoutMs: 5000 });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });

    it('absent timeoutMs keeps the exact current behavior', async () => {
        const res = await call('api/add', { args: [[2, 3]] });
        expect(res.status).toBe(200);
    });
});

describe('handleServerFnRequest — rich wire serialization (rfc-server §4)', () => {
    class Basket {
        items = 3;
    }
    const returnsDate = serverFn({ handler: async () => ({ createdAt: new Date(1_700_000_000_000) }) });
    const returnsMap = serverFn({ handler: async () => new Map([['a', 1]]) });
    const returnsNestedUndefined = serverFn({ handler: async () => ({ a: { b: undefined } }) });
    const returnsInstance = serverFn({ handler: async () => new Basket() });
    const returnsToJson = serverFn({ handler: async () => ({ range: { toJSON: () => [1, 2] } }) });
    const returnsPlain = serverFn({ handler: async () => ({ ok: [1, 2, { deep: true }] }) });
    const returnsRich = serverFn({
        handler: async () => ({
            at: new Date(5),
            tags: new Set(['a']),
            total: 42n,
            home: new URL('https://example.com/'),
            pattern: /ab+c/gi
        })
    });
    const returnsTagLike = serverFn({ handler: async () => ({ $date: 'just a string' }) });
    const echoes = serverFn({ handler: async ({ input: value }: { input: unknown }) => value });
    const returnsCircular = serverFn({
        handler: async () => {
            const c: Record<string, unknown> = { a: 1 };
            c.self = c;
            return c;
        }
    });
    Object.assign(FNS, {
        'api/date': returnsDate,
        'api/map': returnsMap,
        'api/undef': returnsNestedUndefined,
        'api/inst': returnsInstance,
        'api/tojson': returnsToJson,
        'api/plain': returnsPlain,
        'api/rich': returnsRich,
        'api/taglike': returnsTagLike,
        'api/echoes': echoes,
        'api/circular': returnsCircular
    });

    const dataOf = async (symbol: string, args: unknown[] = []): Promise<unknown> =>
        ((await (await call(symbol, { args })).json()) as { data?: unknown }).data;

    it('tags a Date instead of flattening it to a string', async () => {
        expect(await dataOf('api/date')).toEqual({
            createdAt: { $date: 1_700_000_000_000 }
        });
    });

    it('tags a Map instead of emitting {}', async () => {
        expect(await dataOf('api/map')).toEqual({ $map: [['a', 1]] });
    });

    it('keeps a nested undefined property instead of dropping it', async () => {
        expect(await dataOf('api/undef')).toEqual({ a: { b: { $undef: 0 } } });
    });

    it('covers every built-in tag in one payload', async () => {
        expect(await dataOf('api/rich')).toEqual({
            at: { $date: 5 },
            tags: { $set: ['a'] },
            total: { $bigint: '42' },
            home: { $url: 'https://example.com/' },
            pattern: { $regexp: ['ab+c', 'gi'] }
        });
    });

    it('escapes a user object that would be mistaken for a tag', async () => {
        expect(await dataOf('api/taglike')).toEqual({
            $esc: { $date: 'just a string' }
        });
    });

    it('still flattens a class instance and honors toJSON', async () => {
        // Prototypes are NOT recovered — a class instance needs a registered
        // handler, which is what the registry seam is for.
        expect(await dataOf('api/inst')).toEqual({ items: 3 });
        expect(await dataOf('api/tojson')).toEqual({ range: [1, 2] });
    });

    it('leaves plain JSON-safe data byte-identical', async () => {
        expect(await dataOf('api/plain')).toEqual({ ok: [1, 2, { deep: true }] });
    });

    it('decodes rich types in ARGUMENTS, not just results', async () => {
        // The direction that had no coverage at all before §4 landed.
        const echoed = await dataOf('api/echoes', [{ $date: 5 }]);
        expect(echoed).toEqual({ $date: 5 });
    });

    it('revives an argument into a live instance for the handler', async () => {
        let seen: unknown;
        Object.assign(FNS, {
            'api/seen': serverFn({
                handler: async ({ input: v }: { input: unknown }) => {
                    seen = v;
                    return null;
                }
            })
        });
        await call('api/seen', { args: [{ $map: [['k', { $date: 1 }]] }] });
        expect(seen).toBeInstanceOf(Map);
        expect((seen as Map<string, unknown>).get('k')).toBeInstanceOf(Date);
    });

    it('rejects a malformed encoded argument as a 400, not a 500', async () => {
        const res = await call('api/echoes', { args: [{ $bigint: 'not a number' }] });
        expect(res.status).toBe(400);
    });

    it('still fails on a circular result — the one unsupported shape', async () => {
        const res = await call('api/circular', { args: [] });
        expect(res.status).toBe(500);
    });

    it('the prelude runs BEFORE wire revive — a middleware veto beats a malformed encoded arg (#559)', async () => {
        // The codec's revive handlers do attacker-directed work (BigInt digit
        // conversion, RegExp compilation), so an unvetted request must never
        // reach them: the middleware's 401 wins over the reviver's 400.
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (rq) => {
                    rq.responseHeaders.set('set-cookie', 'challenge=1');
                    throw new ServerFnError(401, 'sign in first');
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const res = await call('api/echoes', { args: [{ $bigint: 'not a number' }] });
        expect(res.status).toBe(401);
        // And the #557 rule holds on the post-prelude revive 400 too:
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (rq) => {
                    rq.responseHeaders.set('set-cookie', 'trace=1');
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const reject = await call('api/echoes', { args: [{ $bigint: 'not a number' }] });
        expect(reject.status).toBe(400);
        expect(reject.headers.get('set-cookie')).toBe('trace=1');
    });

    it('a body nesting past the codec depth cap is a clean 400 (#559)', async () => {
        const body = `{"args":[${'{"child":'.repeat(300)}1${'}'.repeat(300)}]}`;
        const res = await call('api/echoes', undefined, { body });
        expect(res.status).toBe(400);
        const parsed = await res.json();
        expect(parsed.error.message).toBe('Malformed encoded value in body');
    });
});

describe('handleServerFnRequest — unvalidated wire-arg warning (#412/#437)', () => {
    it('a fn with no `input` schema behind the endpoint warns once across repeated POSTs', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fn = serverFn({ handler: async ({ input: id }: { input: string }) => id });
            await call('api/direct', { args: ['a'] }, {}, { resolve: () => fn });
            await call('api/direct', { args: ['b'] }, {}, { resolve: () => fn });
            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('"direct"'));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('no `input` validator'));
        } finally {
            warn.mockRestore();
        }
    });
});

/* ------------------------------------------------------------------ */
/* response cap — maxResponseBytes (#571)                             */
/* ------------------------------------------------------------------ */

describe('response cap — maxResponseBytes (#571)', () => {
    it('no cap configured: a large response passes (the unlimited default)', async () => {
        const res = await call('api/echo', { args: ['x'.repeat(100_000)] });
        expect(res.status).toBe(200);
    });

    it('under the cap the body is byte-identical to the uncapped JSON', async () => {
        // Pins the bytes-as-body refactor: capping must not change a single
        // byte of a response that fits.
        const uncapped = await call('api/echo', { args: [{ note: 'héllo wörld' }] });
        const capped = await call(
            'api/echo',
            { args: [{ note: 'héllo wörld' }] },
            {},
            { maxResponseBytes: 10_000 }
        );
        expect(capped.status).toBe(200);
        expect(await capped.text()).toBe(await uncapped.text());
    });

    it('over the cap is a masked 500 and onError sees the cap error', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const seen: unknown[] = [];
        try {
            const res = await call(
                'api/echo',
                { args: ['x'.repeat(2_000)] },
                {},
                { maxResponseBytes: 1_000, onError: (error) => void seen.push(error) }
            );
            expect(res.status).toBe(500);
            const body = (await res.json()) as { error: { message: string } };
            expect(body.error.message).toBe('Internal error');
            expect(seen).toHaveLength(1);
            expect(String(seen[0])).toContain('maxResponseBytes');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('measures UTF-8 bytes, not UTF-16 code units', async () => {
        // 400 four-byte emoji = 800 code units but ~1.6 KB of UTF-8 — a
        // .length metric would let this response through.
        const seen: unknown[] = [];
        const res = await call(
            'api/echo',
            { args: ['🧨'.repeat(400)] },
            {},
            { maxResponseBytes: 1_200, onError: (error) => void seen.push(error) }
        );
        expect(res.status).toBe(500);
        expect(seen).toHaveLength(1);
    });

    it('oversized ServerFnError.data is dropped — error kept, onError NOT fired', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const seen: unknown[] = [];
        const bigData = serverFn({
            handler: async () => {
                throw new ServerFnError(422, 'too big to explain', { detail: 'x'.repeat(5_000) });
            }
        });
        try {
            const res = await call(
                'api/add',
                { args: [] },
                {},
                {
                    resolve: () => bigData,
                    maxResponseBytes: 1_000,
                    onError: (error) => void seen.push(error)
                }
            );
            expect(res.status).toBe(422);
            const body = (await res.json()) as { error: { message: string; data?: unknown } };
            expect(body.error.message).toBe('too big to explain');
            expect(body.error.data).toBeUndefined();
            expect(seen).toHaveLength(0);
            expect(warn.mock.calls.some(([m]) => String(m).includes('maxResponseBytes'))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    it('a small ServerFnError.data survives under the cap', async () => {
        const res = await call(
            'api/polite',
            { args: [] },
            {},
            { maxResponseBytes: 10_000 }
        );
        expect(res.status).toBe(418);
        const body = (await res.json()) as { error: { data: unknown } };
        expect(body.error.data).toEqual({ hint: 'short and stout' });
    });
});
