/**
 * @vitest-environment node
 *
 * __serverFnStub / __serverOnly — the client half of the wire (rfc-server
 * §4, one identity since rfc-server-v5 §1.3–§1.6, #692): request shape
 * (`{base}/{key}` + the build's `v` tag), envelope unwrapping, branded error
 * re-creation, the 409 `version-skew` reload hint, transport `credentials`,
 * and the `flags` bitmask.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    __serverFnStub,
    __serverOnly,
    configureServerFn,
    type BoundaryRefreshSeam
} from '../src/client/index';
import { isServerFnError } from '../src/errors';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );
    vi.stubGlobal('fetch', mock);
    return mock;
}

afterEach(() => {
    vi.unstubAllGlobals();
    configureServerFn(null);
    delete (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: unknown }).__SIGX_SERVERFN_BOUNDARIES__;
});

describe('__serverFnStub', () => {
    it('POSTs {"args","v"} to {base}/{key} and unwraps {data}', async () => {
        const mock = stubFetch(200, { data: 5 });
        const add = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        await expect(add([2, 3])).resolves.toBe(5);

        expect(mock).toHaveBeenCalledWith('/_sigx/fn/api/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[[2,3]],"v":"deadbeef"}'
        });
    });

    it('resolves undefined for an empty envelope', async () => {
        stubFetch(200, {});
        const noop = __serverFnStub('api/noop', 'noop', '/_sigx/fn', 'deadbeef');
        await expect(noop()).resolves.toBeUndefined();
    });

    it('re-creates wire errors with the brand, status, and data', async () => {
        stubFetch(418, { error: { message: 'teapot', status: 418, data: { hint: 'stout' } } });
        const fn = __serverFnStub('api/tea', 'tea', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(418);
        expect((error as { data: unknown }).data).toEqual({ hint: 'stout' });
        expect((error as Error).message).toBe('teapot');
    });

    it('a 409 version-skew envelope throws the reload hint with code: "version-skew"', async () => {
        stubFetch(409, {
            error: { message: 'version skew', status: 409, code: 'version-skew' }
        });
        const fn = __serverFnStub('api/oldFn', 'oldFn', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect(error).toMatchObject({ status: 409, code: 'version-skew' });
        // The hint REPLACES the endpoint's terse message — it is the one
        // thing a user can act on.
        expect((error as Error).message).toContain('"oldFn"');
        expect((error as Error).message).toContain('version skew');
        expect((error as Error).message).toContain('reload');
    });

    it('a 409 WITHOUT code: "version-skew" is an ordinary wire error', async () => {
        stubFetch(409, { error: { message: 'edit conflict', status: 409 } });
        const fn = __serverFnStub('api/save', 'save', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(409);
        expect('code' in (error as object)).toBe(false);
        expect((error as Error).message).toBe('edit conflict');
    });

    it('a bare 404 reads "not found" — no stale-build guess any more', async () => {
        stubFetch(404, '');
        const fn = __serverFnStub('api/oldFn', 'oldFn', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as Error).message).toBe('server function "oldFn" not found (HTTP 404)');
        expect((error as Error).message).not.toContain('stale build');
        expect((error as { status: number }).status).toBe(404);
    });

    it('a structured 404 keeps the server\'s own message', async () => {
        stubFetch(404, { error: { message: 'Unknown server function "api/old"', status: 404 } });
        const fn = __serverFnStub('api/oldFn', 'oldFn', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect((error as Error).message).toBe('Unknown server function "api/old"');
        expect((error as { status: number }).status).toBe(404);
    });

    it('normalizes a base with a trailing slash', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/x', 'x', '/_sigx/fn/', 'deadbeef');
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/api/x');
    });

    it('tolerates non-JSON error bodies (proxy pages)', async () => {
        stubFetch(502, '<html>Bad Gateway</html>');
        const fn = __serverFnStub('api/x', 'x', '/_sigx/fn', 'deadbeef');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(502);
        expect((error as Error).message).toContain('HTTP 502');
    });

    it('a GET-marked stub (flags bit 1) issues GET with args and v in the query string', async () => {
        const mock = stubFetch(200, { data: { id: 'p1' } });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await expect(read({ id: 'p1' })).resolves.toEqual({ id: 'p1' });

        const expectedQuery = encodeURIComponent(JSON.stringify([{ id: 'p1' }]));
        expect(mock).toHaveBeenCalledWith(`/_sigx/fn/api/read?args=${expectedQuery}&v=deadbeef`, {
            method: 'GET',
            headers: {}
        });
    });

    it('a GET stub spends all-scalar args as named params (#355)', async () => {
        const mock = stubFetch(200, { data: 'ok' });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read('shoes', 42, true, null);

        const url = mock.mock.calls[0][0] as string;
        expect(url).toBe('/_sigx/fn/api/read?a0=shoes&a1=42&a2=true&a3=null&v=deadbeef');
        expect(url).not.toContain('%');
    });

    it('a GET stub quotes only a string that would read back as a non-string', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read('42', 'true', 'plain');

        const url = mock.mock.calls[0][0] as string;
        // Round-trip is what matters: the quoted forms come back as strings.
        const params = new URLSearchParams(url.split('?')[1]);
        expect(params.get('a0')).toBe('"42"');
        expect(params.get('a1')).toBe('"true"');
        expect(params.get('a2')).toBe('plain');
    });

    it('a GET stub with no args sends only the version query — no args key', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/api/read?v=deadbeef');
    });

    it('a GET stub with no args and no version sends a bare path, no trailing "?"', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', '', 1);
        await read();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/api/read');
    });

    it('a GET stub falls back to the args blob as soon as one arg is not a scalar', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read('shoes', { page: 2 });

        const url = mock.mock.calls[0][0] as string;
        expect(url).toContain('?args=');
        expect(url).not.toContain('a0=');
    });

    it('a GET stub percent-encodes codec tags into the query value', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read(new Date('2026-07-21T12:00:00.000Z'), 42n);

        const url = mock.mock.calls[0][0] as string;
        const [, rest] = url.split('?args=');
        // `v` rides after the args blob (rfc-server-v5 §3.2).
        expect(rest.endsWith('&v=deadbeef')).toBe(true);
        const query = rest.slice(0, -'&v=deadbeef'.length);
        expect(JSON.parse(decodeURIComponent(query))).toEqual([
            { $date: 1784635200000 },
            { $bigint: '42' }
        ]);
        // Everything outside unreserved chars is percent-encoded — no raw
        // braces/quotes reach the request line.
        expect(query).not.toMatch(/[{}"\s]/);
    });

    it('a GET stub sends no content-type but keeps transport extra headers', async () => {
        const mock = stubFetch(200, {});
        configureServerFn({ headers: { authorization: 'Bearer t', 'Content-Type': 'nope' } });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read();

        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ authorization: 'Bearer t' });
        expect('body' in init).toBe(false);
    });

    it('GET stubs share the envelope path: errors, skew hint, and .with({signal})', async () => {
        stubFetch(409, { error: { message: 'version skew', status: 409, code: 'version-skew' } });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        const error = await read().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect(error).toMatchObject({ status: 409, code: 'version-skew' });
        expect((error as Error).message).toContain('version skew');
        expect((error as Error).message).toContain('reload');

        const mock = stubFetch(200, { data: 1 });
        const controller = new AbortController();
        await read.with({ signal: controller.signal })();
        expect((mock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
    });

    it('an unmarked stub still POSTs — the flag defaults off', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/post', 'post', '/_sigx/fn', 'deadbeef');
        await fn(1);
        expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });

    it('drops an own __proto__ key from the response payload', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            stubFetch(200, '{"data":{"__proto__":{"polluted":true},"ok":1}}');
            const fn = __serverFnStub('api/echo', 'echo', '/_sigx/fn', 'deadbeef');
            await expect(fn()).resolves.toEqual({ ok: 1 });
            // The dev warning is part of the #560 contract — drops are loud.
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('__proto__'));
        } finally {
            warn.mockRestore();
        }
    });

    it('"constructor" survives in the response payload — a plain data key (#560)', async () => {
        // The three-key reviver silently ate a server function returning
        // { constructor: 'Acme Corp' }; only __proto__ is dangerous.
        stubFetch(200, '{"data":{"constructor":"Acme Corp","prototype":"blueprint","ok":1}}');
        const fn = __serverFnStub('api/echo', 'echo', '/_sigx/fn', 'deadbeef');
        await expect(fn()).resolves.toEqual({
            constructor: 'Acme Corp',
            prototype: 'blueprint',
            ok: 1
        });
    });
});

describe('per-call options — .with({ headers }) / .with({ fresh }) (#315)', () => {
    it('sends one-off headers alongside the forced content-type', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/traced', 'traced', '/_sigx/fn', 'deadbeef');
        await fn.with({ headers: { 'x-trace-id': 'abc123' } })(1);
        expect((mock.mock.calls[0][1] as RequestInit).headers).toEqual({
            'x-trace-id': 'abc123',
            'content-type': 'application/json'
        });
    });

    it('per-call headers win over transport headers; content-type stays unoverridable in BOTH', async () => {
        const mock = stubFetch(200, { data: 1 });
        configureServerFn({
            headers: { authorization: 'Bearer stale', 'x-app': 'demo', 'Content-Type': 'nope' }
        });
        const fn = __serverFnStub('api/traced', 'traced', '/_sigx/fn', 'deadbeef');
        await fn.with({
            headers: { authorization: 'Bearer rotated', 'CONTENT-TYPE': 'also-nope' }
        })(1);
        expect((mock.mock.calls[0][1] as RequestInit).headers).toEqual({
            authorization: 'Bearer rotated',
            'x-app': 'demo',
            'content-type': 'application/json'
        });
    });

    it('fresh: true puts cache: no-cache on a GET read fetch', async () => {
        const mock = stubFetch(200, { data: 1 });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read.with({ fresh: true })({ id: 'p1' });
        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.cache).toBe('no-cache');
    });

    it('a GET read WITHOUT fresh sets no cache mode (the declared max-age governs)', async () => {
        const mock = stubFetch(200, { data: 1 });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read({ id: 'p1' });
        expect('cache' in (mock.mock.calls[0][1] as RequestInit)).toBe(false);
    });

    it('fresh on a POST stub is a warned no-op', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/post', 'post', '/_sigx/fn', 'deadbeef');
        await fn.with({ fresh: true })(1);
        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect('cache' in init).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-op'));
    });

    it('headers and fresh compose with a GET read', async () => {
        const mock = stubFetch(200, { data: 1 });
        const read = __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1);
        await read.with({ fresh: true, headers: { 'x-trace-id': 't1' } })({ id: 'p1' });
        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.cache).toBe('no-cache');
        // GET carries the one-off header but never a content-type.
        expect(init.headers).toEqual({ 'x-trace-id': 't1' });
    });
});

describe('configureServerFn (rfc-server rev 2, N.1)', () => {
    it('resolves the transport endpoint at CALL time, over the baked endpoint', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        configureServerFn({ endpoint: 'https://api.example.com/_sigx/fn/' });
        await fn();
        // Trailing slash trimmed, symbol appended as a path segment.
        expect(mock.mock.calls[0][0]).toBe('https://api.example.com/_sigx/fn/api/add');
    });

    it('configureServerFn(null) restores the baked endpoint', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        configureServerFn({ endpoint: 'https://api.example.com/_sigx/fn' });
        configureServerFn(null);
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/api/add');
    });

    it('merges static headers, with content-type NOT overridable — any casing', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        configureServerFn({
            // 'Content-Type' must be stripped too — Headers normalization
            // would otherwise COMBINE it with ours ('text/plain, application/json').
            headers: { authorization: 'Bearer abc', 'Content-Type': 'text/plain' }
        });
        await fn(1);
        expect(mock).toHaveBeenCalledWith('/_sigx/fn/api/add', {
            method: 'POST',
            headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
            body: '{"args":[1],"v":"deadbeef"}'
        });
    });

    it('awaits an async header factory on every call', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        let token = 'first';
        configureServerFn({ headers: async () => ({ authorization: `Bearer ${token}` }) });
        await fn();
        token = 'second';
        await fn();
        expect(mock.mock.calls[0][1].headers.authorization).toBe('Bearer first');
        expect(mock.mock.calls[1][1].headers.authorization).toBe('Bearer second');
    });

    it('uses an injected fetch and leaves the global untouched', async () => {
        const globalMock = stubFetch(200, { data: 'global' });
        const injected = vi.fn(async () => new Response('{"data":"injected"}', { status: 200 }));
        const fn = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        configureServerFn({ fetch: injected as unknown as typeof globalThis.fetch });
        await expect(fn()).resolves.toBe('injected');
        expect(injected).toHaveBeenCalledTimes(1);
        expect(globalMock).not.toHaveBeenCalled();
    });

    it('spends a key as REAL path segments — no percent-encoding (#355)', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('@acme/api/src/cart.server.ts/add', 'add', '/_sigx/fn', 'deadbeef');
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/@acme/api/src/cart.server.ts/add');
        expect(mock.mock.calls[0][0]).not.toContain('%');
    });

    it('still percent-encodes a segment that is not URL-path-safe', async () => {
        const mock = stubFetch(200, { data: 1 });
        // A space and a `?` cannot ride literally; `@` and `.` can.
        const fn = __serverFnStub('@acme/a b?c/add', 'add', '/_sigx/fn', 'deadbeef');
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/@acme/a%20b%3Fc/add');
    });
});

describe('__serverOnly', () => {
    it('throws a descriptive error naming the export and file', () => {
        const stub = __serverOnly('auditLog', 'src/cart.server.ts');
        expect(() => stub()).toThrow(/"auditLog" from src\/cart\.server\.ts is server-only/);
    });
});

describe('__serverFnStub — .with({ signal }) per-call options (#353)', () => {
    it('forwards the signal into the fetch init; the wire args stay the args', async () => {
        const mock = stubFetch(200, { data: 5 });
        const add = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        const controller = new AbortController();
        await expect(add.with({ signal: controller.signal })([2, 3])).resolves.toBe(5);

        expect(mock).toHaveBeenCalledWith('/_sigx/fn/api/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[[2,3]],"v":"deadbeef"}',
            signal: controller.signal
        });
    });

    it('an aborted signal rejects the call', async () => {
        const mock = vi.fn(async (_url: string, init?: RequestInit) => {
            init?.signal?.throwIfAborted();
            return new Response('{"data":1}', { status: 200 });
        });
        vi.stubGlobal('fetch', mock);
        const add = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        const controller = new AbortController();
        controller.abort();
        await expect(add.with({ signal: controller.signal })([2, 3])).rejects.toThrow();
    });

    it('.with({}) and a plain call keep the zero-config init byte-identical', async () => {
        const mock = stubFetch(200, { data: 1 });
        const add = __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef');
        await add.with({})(1);
        await add(1);
        for (const [, init] of mock.mock.calls as [string, RequestInit][]) {
            expect(init).toEqual({
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[1],"v":"deadbeef"}'
            });
            expect('signal' in init).toBe(false);
        }
    });
});

describe('__serverFnStub — rich wire serialization (rfc-server §4)', () => {
    const stub = (): ReturnType<typeof __serverFnStub> =>
        __serverFnStub('api/rich', 'rich', '/_sigx/fn', 'deadbeef');

    it('revives a tagged Date into a live Date', async () => {
        stubFetch(200, { data: { createdAt: { $date: 1_700_000_000_000 } } });
        const out = (await stub()()) as { createdAt: Date };
        expect(out.createdAt).toBeInstanceOf(Date);
        expect(out.createdAt.getTime()).toBe(1_700_000_000_000);
    });

    it('revives every built-in tag', async () => {
        stubFetch(200, {
            data: {
                at: { $date: 5 },
                index: { $map: [['k', 1]] },
                tags: { $set: ['a'] },
                total: { $bigint: '42' },
                home: { $url: 'https://example.com/' },
                pattern: { $regexp: ['ab+c', 'gi'] },
                nothing: { $undef: 0 }
            }
        });
        const out = (await stub()()) as Record<string, unknown>;
        expect(out.at).toBeInstanceOf(Date);
        expect(out.index).toBeInstanceOf(Map);
        expect(out.tags).toBeInstanceOf(Set);
        expect(out.total).toBe(42n);
        expect((out.home as URL).href).toBe('https://example.com/');
        expect((out.pattern as RegExp).flags).toBe('gi');
        expect('nothing' in out).toBe(true);
        expect(out.nothing).toBeUndefined();
    });

    it('unwraps an escaped object without reading its key as a tag', async () => {
        stubFetch(200, { data: { $esc: { $date: 'just a string' } } });
        expect(await stub()()).toEqual({ $date: 'just a string' });
    });

    it('encodes rich types in ARGUMENTS on the way out', async () => {
        const mock = stubFetch(200, { data: null });
        await stub()([new Date(5), new Set(['a']), 7n]);
        const [, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.body).toBe(
            '{"args":[[{"$date":5},{"$set":["a"]},{"$bigint":"7"}]],"v":"deadbeef"}'
        );
    });

    it('leaves a plain payload untouched', async () => {
        const mock = stubFetch(200, { data: { ok: [1, 2] } });
        await expect(stub()([1, 'a'])).resolves.toEqual({ ok: [1, 2] });
        const [, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.body).toBe('{"args":[[1,"a"]],"v":"deadbeef"}');
    });

    it('does not mistake the $cache sidecar for a tag', async () => {
        // A `$`-prefixed sole key at envelope level must not reach the codec.
        stubFetch(200, { $cache: { invalidates: ['cart'] } });
        await expect(stub()()).resolves.toBeUndefined();
    });

    it('revives rich types inside a ServerFnError data payload', async () => {
        stubFetch(422, {
            error: { message: 'nope', status: 422, data: { at: { $date: 5 } } }
        });
        await expect(stub()()).rejects.toMatchObject({
            status: 422,
            data: { at: expect.any(Date) }
        });
    });

    it('leaves an unknown tag in its encoded shape rather than throwing', async () => {
        stubFetch(200, { data: { v: { $fromTheFuture: 1 } } });
        expect(await stub()()).toEqual({ v: { $fromTheFuture: 1 } });
    });
});

describe('__serverFnStub — codec robustness on payloads it did not produce', () => {
    const stub = (): ReturnType<typeof __serverFnStub> =>
        __serverFnStub('api/rich', 'rich', '/_sigx/fn', 'deadbeef');

    it('does not corrupt a non-object $esc payload', async () => {
        // The encoder only ever wraps an OBJECT, so this cannot have come
        // from it; unwrapping blindly would yield {} via Object.keys(1).
        stubFetch(200, { data: { $esc: 1 } });
        expect(await stub()()).toEqual({ $esc: 1 });
    });
});

describe('__serverFnStub — stable data key (#452)', () => {
    it('stamps __sigxKey with the key — the route IS the identity (rfc-server-v5 §1.4)', () => {
        const fn = __serverFnStub('src/cart.server.ts/add', 'add', '/_sigx/fn', 'deadbeef');
        expect(fn.__sigxKey).toBe('src/cart.server.ts/add');
    });

    it('a hand-built stub passing "" keeps the unstamped sentinel (#565)', () => {
        // `''`, not `undefined`: the public type declares `__sigxKey` a
        // required `string` (that is what makes `useData(getVotes)`
        // type-check), so the runtime keeps the declaration true. `''` is what
        // both readers already treat as "no key" — `isServerFnDataRef` and the
        // endpoint's pattern resolver each test `key !== ''`.
        const fn = __serverFnStub('', 'add', '/_sigx/fn', 'deadbeef');
        expect(fn.__sigxKey).toBe('');
    });
});

describe('__serverFnStub — version tag on the wire (rfc-server-v5 §3.2)', () => {
    it('an empty version sends no "v" — POST body and GET query alike', async () => {
        const mock = stubFetch(200, { data: 1 });
        await __serverFnStub('api/add', 'add', '/_sigx/fn', '')(1);
        await __serverFnStub('api/read', 'read', '/_sigx/fn', '', 1)('p1');
        expect((mock.mock.calls[0][1] as RequestInit).body).toBe('{"args":[1]}');
        expect(mock.mock.calls[1][0]).toBe('/_sigx/fn/api/read?a0=p1');
    });

    it('"v" rides after "args" and before "$boundaries" in the POST envelope', async () => {
        const mock = stubFetch(200, { data: 1 });
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = {
                collect: () => ({ base: 4, refresh: [{ id: 3, component: 'T' }] }),
                apply: () => {}
            };
        await __serverFnStub('api/vote', 'vote', '/_sigx/fn', 'deadbeef', 2)(1);
        expect((mock.mock.calls[0][1] as RequestInit).body).toBe(
            '{"args":[1],"v":"deadbeef","$boundaries":{"base":4,"refresh":[{"id":3,"component":"T"}]}}'
        );
    });
});

describe('__serverFnStub — flags bitmask', () => {
    const installSeam = (): ReturnType<typeof vi.fn> => {
        const collect = vi.fn(() => ({ base: 4, refresh: [{ id: 3, component: 'T' }] }));
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = { collect, apply: () => {} };
        return collect;
    };

    it('omitted / 0: POST, no sidecar', async () => {
        const collect = installSeam();
        const mock = stubFetch(200, { data: 1 });
        await __serverFnStub('api/fn', 'fn', '/_sigx/fn', 'deadbeef')(1);
        await __serverFnStub('api/fn', 'fn', '/_sigx/fn', 'deadbeef', 0)(1);
        for (const [, init] of mock.mock.calls as [string, RequestInit][]) {
            expect(init.method).toBe('POST');
            expect(init.body).toBe('{"args":[1],"v":"deadbeef"}');
        }
        expect(collect).not.toHaveBeenCalled();
    });

    it('1: a GET read', async () => {
        const collect = installSeam();
        const mock = stubFetch(200, { data: 1 });
        await __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1)('p1');
        const [url, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('GET');
        expect(url).toBe('/_sigx/fn/api/read?a0=p1&v=deadbeef');
        expect(collect).not.toHaveBeenCalled();
    });

    it('2: a POST carrying the §6.3 boundaries sidecar', async () => {
        const collect = installSeam();
        const mock = stubFetch(200, { data: 1 });
        await __serverFnStub('api/vote', 'vote', '/_sigx/fn', 'deadbeef', 2)(1);
        const [, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('POST');
        expect(collect).toHaveBeenCalledTimes(1);
        expect(JSON.parse(init.body as string)).toEqual({
            args: [1],
            v: 'deadbeef',
            $boundaries: { base: 4, refresh: [{ id: 3, component: 'T' }] }
        });
    });

    it('3: both bits set — the GET bit wins the method; a GET has no body, so no sidecar', async () => {
        // `serverFn` refuses `cache` + `invalidates` at definition time, so the
        // build never mints 3; the stub still reads each bit independently
        // and the inventory is collected only where it can ride (a POST).
        const collect = installSeam();
        const mock = stubFetch(200, { data: 1 });
        await __serverFnStub('api/both', 'both', '/_sigx/fn', 'deadbeef', 3)('p1');
        const [url, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('GET');
        expect(url).toBe('/_sigx/fn/api/both?a0=p1&v=deadbeef');
        expect('body' in init).toBe(false);
        expect(collect).not.toHaveBeenCalled();
    });
});

describe('configureServerFn({ credentials }) (rfc-server-v5 §1.8)', () => {
    it('puts credentials on the POST init when set', async () => {
        const mock = stubFetch(200, { data: 1 });
        configureServerFn({ credentials: 'include' });
        await __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef')(1);
        expect(mock).toHaveBeenCalledWith('/_sigx/fn/api/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[1],"v":"deadbeef"}',
            credentials: 'include'
        });
    });

    it('puts credentials on the GET init when set', async () => {
        const mock = stubFetch(200, { data: 1 });
        configureServerFn({ credentials: 'include' });
        await __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1)('p1');
        expect(mock).toHaveBeenCalledWith('/_sigx/fn/api/read?a0=p1&v=deadbeef', {
            method: 'GET',
            headers: {},
            credentials: 'include'
        });
    });

    it('sends no credentials key at all when unset — the platform default governs', async () => {
        const mock = stubFetch(200, { data: 1 });
        configureServerFn({ endpoint: '/_sigx/fn' });
        await __serverFnStub('api/add', 'add', '/_sigx/fn', 'deadbeef')(1);
        await __serverFnStub('api/read', 'read', '/_sigx/fn', 'deadbeef', 1)('p1');
        for (const [, init] of mock.mock.calls as [string, RequestInit][]) {
            expect('credentials' in init).toBe(false);
        }
    });
});
