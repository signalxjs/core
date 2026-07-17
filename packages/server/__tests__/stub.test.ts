/**
 * @vitest-environment node
 *
 * __serverFnStub / __serverOnly — the client half of the wire (rfc-server
 * §4): request shape, envelope unwrapping, branded error re-creation, and
 * the version-skew 404 message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { __serverFnStub, __serverOnly } from '../src/client/index';
import { isServerFnError } from '../src/errors';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );
    vi.stubGlobal('fetch', mock);
    return mock;
}

afterEach(() => vi.unstubAllGlobals());

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

    it('drops dangerous keys from the response payload', async () => {
        stubFetch(200, '{"data":{"__proto__":{"polluted":true},"ok":1}}');
        const fn = __serverFnStub('e_fn_00000006', 'echo', '/_sigx/fn');
        await expect(fn()).resolves.toEqual({ ok: 1 });
    });
});

describe('__serverOnly', () => {
    it('throws a descriptive error naming the export and file', () => {
        const stub = __serverOnly('auditLog', 'src/cart.server.ts');
        expect(() => stub()).toThrow(/"auditLog" from src\/cart\.server\.ts is server-only/);
    });
});
