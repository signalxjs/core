/**
 * @vitest-environment node
 *
 * __serverFnStub / __serverOnly — the client half of the wire (rfc-server
 * §4): request shape, envelope unwrapping, branded error re-creation, and
 * the version-skew 404 message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { __serverFnStub, __serverOnly, configureServerFn } from '../src/client/index';
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
});

describe('__serverFnStub', () => {
    it('POSTs {"args"} to {base}/{symbol} and unwraps {data}', async () => {
        const mock = stubFetch(200, { data: 5 });
        const add = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        await expect(add(2, 3)).resolves.toBe(5);

        expect(mock).toHaveBeenCalledWith('/_sigx/fn/add_fn_00000001', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[2,3]}'
        });
    });

    it('resolves undefined for an empty envelope', async () => {
        stubFetch(200, {});
        const noop = __serverFnStub('noop_fn_00000002', 'noop', '/_sigx/fn');
        await expect(noop()).resolves.toBeUndefined();
    });

    it('re-creates wire errors with the brand, status, and data', async () => {
        stubFetch(418, { error: { message: 'teapot', status: 418, data: { hint: 'stout' } } });
        const fn = __serverFnStub('t_fn_00000003', 'tea', '/_sigx/fn');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(418);
        expect((error as { data: unknown }).data).toEqual({ hint: 'stout' });
        expect((error as Error).message).toBe('teapot');
    });

    it('surfaces a bare 404 as a version-skew hint', async () => {
        stubFetch(404, '');
        const fn = __serverFnStub('old_fn_00000004', 'oldFn', '/_sigx/fn');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as Error).message).toContain('stale build');
        expect((error as { status: number }).status).toBe(404);
    });

    it('uses the skew hint even for the structured 404 envelope', async () => {
        stubFetch(404, { error: { message: 'Unknown server function "old"', status: 404 } });
        const fn = __serverFnStub('old_fn_00000007', 'oldFn', '/_sigx/fn');
        const error = await fn().catch((e: unknown) => e);
        expect((error as Error).message).toContain('stale build');
    });

    it('normalizes a base with a trailing slash', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('x_fn_00000008', 'x', '/_sigx/fn/');
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/x_fn_00000008');
    });

    it('tolerates non-JSON error bodies (proxy pages)', async () => {
        stubFetch(502, '<html>Bad Gateway</html>');
        const fn = __serverFnStub('x_fn_00000005', 'x', '/_sigx/fn');
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(502);
        expect((error as Error).message).toContain('HTTP 502');
    });

    it('a GET-marked stub (4th flag) issues GET with args in the query string', async () => {
        const mock = stubFetch(200, { data: { id: 'p1' } });
        const read = __serverFnStub('read_fn_00000010', 'read', '/_sigx/fn', 1);
        await expect(read({ id: 'p1' })).resolves.toEqual({ id: 'p1' });

        const expectedQuery = encodeURIComponent(JSON.stringify([{ id: 'p1' }]));
        expect(mock).toHaveBeenCalledWith(`/_sigx/fn/read_fn_00000010?args=${expectedQuery}`, {
            method: 'GET',
            headers: {}
        });
    });

    it('a GET stub percent-encodes codec tags into the query value', async () => {
        const mock = stubFetch(200, {});
        const read = __serverFnStub('read_fn_00000011', 'read', '/_sigx/fn', 1);
        await read(new Date('2026-07-21T12:00:00.000Z'), 42n);

        const url = mock.mock.calls[0][0] as string;
        const [, query] = url.split('?args=');
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
        const read = __serverFnStub('read_fn_00000012', 'read', '/_sigx/fn', 1);
        await read();

        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ authorization: 'Bearer t' });
        expect('body' in init).toBe(false);
    });

    it('GET stubs share the envelope path: errors, skew hint, and .with({signal})', async () => {
        stubFetch(404, '');
        const read = __serverFnStub('read_fn_00000013', 'read', '/_sigx/fn', 1);
        const error = await read().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as Error).message).toContain('stale build');

        const mock = stubFetch(200, { data: 1 });
        const controller = new AbortController();
        await read.with({ signal: controller.signal })();
        expect((mock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
    });

    it('an unmarked stub still POSTs — the flag defaults off', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('post_fn_00000014', 'post', '/_sigx/fn');
        await fn(1);
        expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });

    it('drops dangerous keys from the response payload', async () => {
        stubFetch(200, '{"data":{"__proto__":{"polluted":true},"ok":1}}');
        const fn = __serverFnStub('e_fn_00000006', 'echo', '/_sigx/fn');
        await expect(fn()).resolves.toEqual({ ok: 1 });
    });
});

describe('per-call options — .with({ headers }) / .with({ fresh }) (#315)', () => {
    it('sends one-off headers alongside the forced content-type', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('t_fn_00000020', 'traced', '/_sigx/fn');
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
        const fn = __serverFnStub('t_fn_00000021', 'traced', '/_sigx/fn');
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
        const read = __serverFnStub('r_fn_00000022', 'read', '/_sigx/fn', 1);
        await read.with({ fresh: true })({ id: 'p1' });
        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.cache).toBe('no-cache');
    });

    it('a GET read WITHOUT fresh sets no cache mode (the declared max-age governs)', async () => {
        const mock = stubFetch(200, { data: 1 });
        const read = __serverFnStub('r_fn_00000023', 'read', '/_sigx/fn', 1);
        await read({ id: 'p1' });
        expect('cache' in (mock.mock.calls[0][1] as RequestInit)).toBe(false);
    });

    it('fresh on a POST stub is a warned no-op', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('p_fn_00000024', 'post', '/_sigx/fn');
        await fn.with({ fresh: true })(1);
        const init = mock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect('cache' in init).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-op'));
    });

    it('headers and fresh compose with a GET read', async () => {
        const mock = stubFetch(200, { data: 1 });
        const read = __serverFnStub('r_fn_00000025', 'read', '/_sigx/fn', 1);
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
        const fn = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        configureServerFn({ endpoint: 'https://api.example.com/_sigx/fn/' });
        await fn();
        // Trailing slash trimmed, symbol appended as a path segment.
        expect(mock.mock.calls[0][0]).toBe('https://api.example.com/_sigx/fn/add_fn_00000001');
    });

    it('configureServerFn(null) restores the baked endpoint', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        configureServerFn({ endpoint: 'https://api.example.com/_sigx/fn' });
        configureServerFn(null);
        await fn();
        expect(mock.mock.calls[0][0]).toBe('/_sigx/fn/add_fn_00000001');
    });

    it('merges static headers, with content-type NOT overridable — any casing', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        configureServerFn({
            // 'Content-Type' must be stripped too — Headers normalization
            // would otherwise COMBINE it with ours ('text/plain, application/json').
            headers: { authorization: 'Bearer abc', 'Content-Type': 'text/plain' }
        });
        await fn(1);
        expect(mock).toHaveBeenCalledWith('/_sigx/fn/add_fn_00000001', {
            method: 'POST',
            headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
            body: '{"args":[1]}'
        });
    });

    it('awaits an async header factory on every call', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
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
        const fn = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        configureServerFn({ fetch: injected as unknown as typeof globalThis.fetch });
        await expect(fn()).resolves.toBe('injected');
        expect(injected).toHaveBeenCalledTimes(1);
        expect(globalMock).not.toHaveBeenCalled();
    });

    it('URL-encodes the symbol into a single path segment (stable symbols)', async () => {
        const mock = stubFetch(200, { data: 1 });
        const fn = __serverFnStub('@acme/api/src/cart.server.ts#add', 'add', '/_sigx/fn');
        await fn();
        expect(mock.mock.calls[0][0]).toBe(
            '/_sigx/fn/%40acme%2Fapi%2Fsrc%2Fcart.server.ts%23add'
        );
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
        const add = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        const controller = new AbortController();
        await expect(add.with({ signal: controller.signal })(2, 3)).resolves.toBe(5);

        expect(mock).toHaveBeenCalledWith('/_sigx/fn/add_fn_00000001', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"args":[2,3]}',
            signal: controller.signal
        });
    });

    it('an aborted signal rejects the call', async () => {
        const mock = vi.fn(async (_url: string, init?: RequestInit) => {
            init?.signal?.throwIfAborted();
            return new Response('{"data":1}', { status: 200 });
        });
        vi.stubGlobal('fetch', mock);
        const add = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        const controller = new AbortController();
        controller.abort();
        await expect(add.with({ signal: controller.signal })(2, 3)).rejects.toThrow();
    });

    it('.with({}) and a plain call keep the zero-config init byte-identical', async () => {
        const mock = stubFetch(200, { data: 1 });
        const add = __serverFnStub('add_fn_00000001', 'add', '/_sigx/fn');
        await add.with({})(1);
        await add(1);
        for (const [, init] of mock.mock.calls as [string, RequestInit][]) {
            expect(init).toEqual({
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"args":[1]}'
            });
            expect('signal' in init).toBe(false);
        }
    });
});

describe('__serverFnStub — rich wire serialization (rfc-server §4)', () => {
    const stub = (): ReturnType<typeof __serverFnStub> =>
        __serverFnStub('rich_fn_00000001', 'rich', '/_sigx/fn');

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
        await stub()(new Date(5), new Set(['a']), 7n);
        const [, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.body).toBe(
            '{"args":[{"$date":5},{"$set":["a"]},{"$bigint":"7"}]}'
        );
    });

    it('leaves a plain payload untouched', async () => {
        const mock = stubFetch(200, { data: { ok: [1, 2] } });
        await expect(stub()(1, 'a')).resolves.toEqual({ ok: [1, 2] });
        const [, init] = mock.mock.calls[0] as [string, RequestInit];
        expect(init.body).toBe('{"args":[1,"a"]}');
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
        __serverFnStub('rich_fn_00000001', 'rich', '/_sigx/fn');

    it('does not corrupt a non-object $esc payload', async () => {
        // The encoder only ever wraps an OBJECT, so this cannot have come
        // from it; unwrapping blindly would yield {} via Object.keys(1).
        stubFetch(200, { data: { $esc: 1 } });
        expect(await stub()()).toEqual({ $esc: 1 });
    });
});
