/**
 * @vitest-environment node
 *
 * createServerFnHandler() — the connect-style adapter, exercised over a real
 * node:http round trip: request bridging, prefix routing, and duplicate
 * response headers (multiple set-cookie values must all survive).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createServerFnHandler } from '../src/node';
import { serverFn, serverStream } from '../src/index';

const twoCookies = serverFn(async (rq) => {
    rq.responseHeaders.append('set-cookie', 'a=1; Path=/');
    rq.responseHeaders.append('set-cookie', 'b=2; Path=/');
    return 'ok';
});
const add = serverFn(async (_rq, a: number, b: number) => a + b);

let releaseSecondTick: () => void = () => {};
const tickGate = new Promise<void>((resolve) => {
    releaseSecondTick = resolve;
});
const ticks = serverStream(async function* () {
    yield 'first';
    await tickGate;
    yield 'second';
});

describe('createServerFnHandler over node:http', () => {
    let server: Server;
    let origin: string;

    beforeAll(async () => {
        const handler = createServerFnHandler({
            functions: {
                cookies_fn_00000001: async () => twoCookies,
                add_fn_00000002: async () => add,
                ticks_fn_00000003: async () => ticks
            }
        });
        server = createServer((req, res) => {
            void handler(req, res, (err) => {
                res.statusCode = err ? 500 : 404;
                res.end(err ? 'error' : 'fallthrough');
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        origin = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
    });

    it('bridges the request and returns the envelope', async () => {
        const res = await fetch(`${origin}/_sigx/fn/add_fn_00000002`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: '{"args":[20,22]}'
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: 42 });
    });

    it('preserves MULTIPLE set-cookie headers end to end', async () => {
        const res = await fetch(`${origin}/_sigx/fn/cookies_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: '{"args":[]}'
        });
        expect(res.status).toBe(200);
        const cookies = res.headers.getSetCookie();
        expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    });

    it('honors x-forwarded-proto for the same-origin check (TLS proxy)', async () => {
        const httpsOrigin = origin.replace('http://', 'https://');
        const res = await fetch(`${origin}/_sigx/fn/add_fn_00000002`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: httpsOrigin,
                'x-forwarded-proto': 'https'
            },
            body: '{"args":[1,1]}'
        });
        expect(res.status).toBe(200);
    });

    it('honors x-forwarded-host for the same-origin check (host-rewriting proxy)', async () => {
        const res = await fetch(`${origin}/_sigx/fn/add_fn_00000002`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: 'https://app.example',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'app.example'
            },
            body: '{"args":[1,1]}'
        });
        expect(res.status).toBe(200);
    });

    it('passes non-matching URLs to next()', async () => {
        const res = await fetch(`${origin}/somewhere-else`);
        expect(res.status).toBe(404);
        await expect(res.text()).resolves.toBe('fallthrough');
    });

    it('streams serverStream NDJSON progressively — chunks arrive BEFORE the generator ends', async () => {
        const res = await fetch(`${origin}/_sigx/fn/ticks_fn_00000003`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: '{"args":[]}'
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/x-ndjson');
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        // The first line must arrive while the generator is still GATED on
        // its second yield — a buffering adapter would hang right here.
        let received = '';
        while (!received.includes('\n')) {
            const { value, done } = await reader.read();
            if (done) throw new Error('stream ended before the first line');
            received += decoder.decode(value, { stream: true });
        }
        expect(received).toContain('{"chunk":"first"}');
        expect(received).not.toContain('second');
        releaseSecondTick();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
        }
        expect(received.split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([
            { chunk: 'first' },
            { chunk: 'second' },
            { done: 1 }
        ]);
    });
});


describe('createServerFnHandler — onError/timeoutMs forwarding (#349/#350)', () => {
    let server: Server;
    let origin: string;
    const errors: unknown[] = [];

    beforeAll(async () => {
        const never = serverFn(async () => new Promise(() => {}));
        const handler = createServerFnHandler({
            functions: { never_fn_00000009: async () => never },
            timeoutMs: 30,
            onError: (error) => {
                errors.push(error);
            }
        });
        server = createServer((req, res) => {
            void handler(req, res, (err) => {
                res.statusCode = err ? 500 : 404;
                res.end(err ? 'error' : 'fallthrough');
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        origin = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
    });

    it('a hung fn 504s over real http and the onError hook captured the timeout', async () => {
        const res = await fetch(`${origin}/_sigx/fn/never_fn_00000009`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: '{"args":[]}'
        });
        expect(res.status).toBe(504);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Server function timed out', status: 504 }
        });
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toContain('timed out after 30ms');
    });
});
