/**
 * @vitest-environment node
 *
 * serverStream() — async-generator server functions (rfc-server §6.1):
 * the wrapper (in-process = the generator itself, live-client guard), the
 * endpoint's NDJSON transport (chunk/done/error lines, header freeze at
 * first yield, §5 masking), and the streaming client stub (AsyncIterable,
 * lazy start, abort on break, truncation detection).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { serverStream, serverFn, ServerFnError } from '../src/index';
import { handleServerFnRequest } from '../src/server/index';
import { __serverStreamStub, configureServerFn } from '../src/client/index';
import { isServerFnError } from '../src/errors';

const ORIGIN = 'http://localhost';

const collect = async <T,>(iterable: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    configureServerFn(null);
    delete (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;
});

/* ------------------------------------------------------------------ */
/* wrapper                                                            */
/* ------------------------------------------------------------------ */

describe('serverStream — wrapper', () => {
    it('is marked for transports and in-process calls get the generator directly', async () => {
        const count = serverStream(async function* count(_rq, upTo: number) {
            for (let i = 1; i <= upTo; i++) yield i;
        });
        expect(count.__sigxStream).toBe(true);
        expect(typeof count.__sigxFn).toBe('function');
        await expect(collect(count(3))).resolves.toEqual([1, 2, 3]);
    });

    it('rq.request throws the detached-context error in-process', async () => {
        const leaky = serverStream(async function* (rq) {
            yield rq.request.url;
        });
        await expect(collect(leaky())).rejects.toThrow(/in-process server-function call/);
    });

    it('throws in a declared live client — stream bodies never run there', () => {
        const s = serverStream(async function* leakedStream() {
            yield 'secret';
        });
        (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__ = true;
        expect(() => s()).toThrow(/"leakedStream" reached a live client unextracted/);
        // The .with() path goes through the same guard — a bound-options call
        // is not a way around it (#448).
        expect(() => s.with({ signal: new AbortController().signal })()).toThrow(
            /"leakedStream" reached a live client unextracted/
        );
    });
});

/* ------------------------------------------------------------------ */
/* per-call options — .with() (#448)                                   */
/* ------------------------------------------------------------------ */

describe('serverStream — .with() in-process (#448)', () => {
    it('.with({ context }) supplies the request an SSR-time stream needs', async () => {
        const tail = serverStream(async function* (rq) {
            yield rq.url.pathname;
            yield rq.request.headers.get('cookie');
        });
        const request = new Request('https://example.com/feed', {
            headers: { cookie: 'session=alice' }
        });
        await expect(collect(tail.with({ context: request })())).resolves.toEqual([
            '/feed',
            'session=alice'
        ]);
    });

    it('accepts a partial context, not just a Request', async () => {
        const readsLocals = serverStream(async function* (rq) {
            yield rq.locals.user;
        });
        await expect(
            collect(readsLocals.with({ context: { locals: { user: 'bob' } } })())
        ).resolves.toEqual(['bob']);
    });

    it('.with({ signal }) becomes rq.abortSignal', async () => {
        const controller = new AbortController();
        const watches = serverStream(async function* (rq) {
            yield rq.abortSignal.aborted;
            controller.abort();
            yield rq.abortSignal.aborted;
        });
        await expect(collect(watches.with({ signal: controller.signal })())).resolves.toEqual([
            false,
            true
        ]);
    });

    it('a per-call signal still wins over the supplied context request signal', async () => {
        const outer = new AbortController();
        const requestAbort = new AbortController();
        const reads = serverStream(async function* (rq) {
            yield rq.abortSignal;
        });
        const [signal] = await collect(
            reads.with({
                signal: outer.signal,
                context: new Request('https://example.com/feed', { signal: requestAbort.signal })
            })()
        );
        expect(signal).toBe(outer.signal);
    });

    it('.with({ headers }) dev-warns — there is no HTTP request in-process', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = serverStream(async function* () {
            yield 1;
        });
        await collect(s.with({ headers: { 'x-trace-id': 't1' } })());
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('.with({ headers }) is ignored on an in-process');
    });

    it('is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = serverStream(async function* () {
            yield 1;
        });
        await collect(s.with({ headers: { 'x-trace-id': 't1' } })());
        expect(warn).not.toHaveBeenCalled();
    });

    it('a bare .with() call behaves exactly like a plain one', async () => {
        const count = serverStream(async function* (_rq, upTo: number) {
            for (let i = 1; i <= upTo; i++) yield i;
        });
        await expect(collect(count.with()(2))).resolves.toEqual([1, 2]);
        // …and still throws the detached-context error when nothing supplies
        // a request, exactly as the plain call does.
        const leaky = serverStream(async function* (rq) {
            yield rq.request.url;
        });
        await expect(collect(leaky.with({})())).rejects.toThrow(/in-process server-function call/);
    });
});

/* ------------------------------------------------------------------ */
/* endpoint (NDJSON)                                                  */
/* ------------------------------------------------------------------ */

const post = (fn: unknown, body = '{"args":[]}'): Promise<Response> =>
    handleServerFnRequest(
        new Request(`${ORIGIN}/_sigx/fn/s_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body
        }),
        { resolve: () => fn }
    );

const lines = async (res: Response): Promise<unknown[]> =>
    (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

describe('serverStream — endpoint NDJSON', () => {
    it('streams {"chunk"} lines then {"done":1} as application/x-ndjson', async () => {
        // Silence the #412 unvalidated-wire-args warning — wire args on a
        // stream are exactly what it fires on.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = serverStream(async function* (_rq, upTo: number) {
            for (let i = 1; i <= upTo; i++) yield `part-${i}`;
        });
        const res = await post(s, '{"args":[2]}');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/x-ndjson');
        await expect(lines(res)).resolves.toEqual([
            { chunk: 'part-1' },
            { chunk: 'part-2' },
            { done: 1 }
        ]);
    });

    it('an empty generator streams just the done line', async () => {
        const s = serverStream(async function* () {});
        await expect(lines(await post(s))).resolves.toEqual([{ done: 1 }]);
    });

    it('headers and status set BEFORE the first yield apply to the response', async () => {
        const s = serverStream(async function* (rq) {
            rq.responseHeaders.set('x-stream', 'yes');
            rq.status(201);
            yield 'a';
        });
        const res = await post(s);
        expect(res.status).toBe(201);
        expect(res.headers.get('x-stream')).toBe('yes');
    });

    it('a throw BEFORE the first yield is an ordinary buffered JSON error', async () => {
        const s = serverStream(async function* (rq) {
            void rq;
            throw new ServerFnError(403, 'not yours');
            yield 'never';
        });
        const res = await post(s);
        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({
            error: { message: 'not yours', status: 403 }
        });
    });

    it('a mid-stream ServerFnError travels in-band verbatim', async () => {
        const s = serverStream(async function* () {
            yield 'ok';
            throw new ServerFnError(410, 'source gone', { at: 2 });
        });
        await expect(lines(await post(s))).resolves.toEqual([
            { chunk: 'ok' },
            { error: { message: 'source gone', status: 410, data: { at: 2 } } }
        ]);
    });

    it('a mid-stream generic throw is masked in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const s = serverStream(async function* () {
            yield 'ok';
            throw new Error('secret internals');
        });
        const emitted = await lines(await post(s));
        expect(emitted[0]).toEqual({ chunk: 'ok' });
        expect(emitted[1]).toEqual({ error: { message: 'Internal error', status: 500 } });
        expect(JSON.stringify(emitted)).not.toContain('secret internals');
    });

    it('a mid-stream masked throw still reaches the onError seam (#349)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const errors: unknown[] = [];
        const s = serverStream(async function* () {
            yield 'ok';
            throw new Error('secret internals');
        });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/s_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: () => s,
                onError: (error) => {
                    errors.push(error);
                }
            }
        );
        const emitted = await lines(res);
        expect(emitted[1]).toEqual({ error: { message: 'Internal error', status: 500 } });
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('secret internals');
    });

    it('a mid-stream ServerFnError does NOT fire onError', async () => {
        const errors: unknown[] = [];
        const s = serverStream(async function* () {
            yield 'ok';
            throw new ServerFnError(410, 'source gone');
        });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/s_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: () => s,
                onError: (error) => {
                    errors.push(error);
                }
            }
        );
        await lines(res);
        expect(errors).toHaveLength(0);
    });

    /** A cycle is the one shape the §4 codec still cannot encode. */
    const cyclic = (): Record<string, unknown> => {
        const c: Record<string, unknown> = { a: 1 };
        c.self = c;
        return c;
    };

    it('an unserializable FIRST chunk is a buffered error AND the generator is disposed', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        let finallyRan = false;
        const s = serverStream(async function* () {
            try {
                yield cyclic(); // circular — still unencodable
                yield 'never';
            } finally {
                finallyRan = true;
            }
        });
        const res = await post(s);
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({
            error: { message: 'Internal error', status: 500 }
        });
        await vi.waitFor(() => expect(finallyRan).toBe(true));
    });

    it('an unserializable MID-STREAM chunk ends the stream in-band and disposes the generator', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        let finallyRan = false;
        const s = serverStream(async function* () {
            try {
                yield 'ok';
                yield cyclic();
                yield 'never';
            } finally {
                finallyRan = true;
            }
        });
        const emitted = await lines(await post(s));
        expect(emitted[0]).toEqual({ chunk: 'ok' });
        expect(emitted[1]).toEqual({ error: { message: 'Internal error', status: 500 } });
        await vi.waitFor(() => expect(finallyRan).toBe(true));
    });

    it('a BigInt chunk now streams instead of killing the stream (§4)', async () => {
        // Both of these used to be the failure cases above: BigInt threw in
        // JSON.stringify, so it terminated the stream either buffered or
        // in-band depending on position.
        const s = serverStream(async function* () {
            yield { big: 10n };
            yield { at: new Date(5) };
        });
        const emitted = await lines(await post(s));
        expect(emitted[0]).toEqual({ chunk: { big: { $bigint: '10' } } });
        expect(emitted[1]).toEqual({ chunk: { at: { $date: 5 } } });
        expect(emitted[2]).toEqual({ done: 1 });
    });

    it('cancelling the response body returns the generator (finally runs)', async () => {
        let finallyRan = false;
        const s = serverStream(async function* () {
            try {
                for (let i = 0; ; i++) yield i;
            } finally {
                finallyRan = true;
            }
        });
        const res = await post(s);
        const reader = res.body!.getReader();
        await reader.read(); // first chunk
        await reader.cancel();
        await vi.waitFor(() => expect(finallyRan).toBe(true));
    });

    it('the guard still runs before a stream (a veto is a buffered error)', async () => {
        const s = serverStream(async function* () {
            yield 'never';
        });
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/s_fn_00000001`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[]}'
            }),
            {
                resolve: () => s,
                guard: () => {
                    throw new ServerFnError(401, 'sign in first');
                }
            }
        );
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({
            error: { message: 'sign in first', status: 401 }
        });
    });
});

/* ------------------------------------------------------------------ */
/* client stub                                                        */
/* ------------------------------------------------------------------ */

const ndjsonResponse = (body: string, init: ResponseInit = {}): Response =>
    new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
        ...init
    });

describe('__serverStreamStub', () => {
    it('POSTs the envelope lazily and yields each chunk until done', async () => {
        const mock = vi.fn(async () => ndjsonResponse('{"chunk":"a"}\n{"chunk":"b"}\n{"done":1}\n'));
        vi.stubGlobal('fetch', mock);
        const stub = __serverStreamStub('s_fn_00000001', 'explain', '/_sigx/fn');
        const iterable = stub('topic', 2);
        expect(mock).not.toHaveBeenCalled(); // lazy — no request until iterated
        await expect(collect(iterable)).resolves.toEqual(['a', 'b']);
        expect(mock).toHaveBeenCalledTimes(1);
        const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/_sigx/fn/s_fn_00000001');
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{"args":["topic",2]}');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('an {"error"} line throws the branded wire error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            ndjsonResponse('{"chunk":"a"}\n{"error":{"message":"source gone","status":410}}\n')
        ));
        const stub = __serverStreamStub('s_fn_00000001', 'explain', '/_sigx/fn');
        const seen: unknown[] = [];
        const error = await (async () => {
            for await (const chunk of stub()) seen.push(chunk);
        })().catch((e: unknown) => e);
        expect(seen).toEqual(['a']);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(410);
        expect((error as Error).message).toBe('source gone');
    });

    it('a non-ok pre-stream response throws like a fn stub (404 = skew hint)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            new Response('{"error":{"message":"Unknown server function","status":404}}', { status: 404 })
        ));
        const stub = __serverStreamStub('old_fn_00000001', 'oldStream', '/_sigx/fn');
        const error = await collect(stub()).catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(404);
    });

    it('consumer break aborts the fetch', async () => {
        let observed: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            observed = init.signal as AbortSignal;
            // An endless body — only break can end this.
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(encoder.encode('{"chunk":1}\n'));
                }
            });
            return new Response(body, { status: 200 });
        }));
        const stub = __serverStreamStub('s_fn_00000001', 'endless', '/_sigx/fn');
        for await (const chunk of stub()) {
            expect(chunk).toBe(1);
            break;
        }
        expect(observed?.aborted).toBe(true);
    });

    it('a body that ends without a terminator throws (truncation ≠ completion)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse('{"chunk":"a"}\n')));
        const stub = __serverStreamStub('s_fn_00000001', 'cutOff', '/_sigx/fn');
        const error = await collect(stub()).catch((e: unknown) => e);
        expect((error as Error).message).toContain('without a done/error terminator');

        // …and a PARTIAL final line is truncation too, not a crash.
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse('{"chunk":"a"}\n{"chu')));
        const partial = await collect(stub()).catch((e: unknown) => e);
        expect((partial as Error).message).toContain('without a done/error terminator');
    });

    it('honors a final terminator line WITHOUT a trailing newline', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse('{"chunk":"a"}\n{"done":1}')));
        const stub = __serverStreamStub('s_fn_00000001', 'noTrailingNl', '/_sigx/fn');
        await expect(collect(stub())).resolves.toEqual(['a']);

        vi.stubGlobal('fetch', vi.fn(async () =>
            ndjsonResponse('{"error":{"message":"gone","status":410}}')
        ));
        const error = await collect(stub()).catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as { status: number }).status).toBe(410);
    });

    it('reassembles a multi-byte code point split across reads', async () => {
        const encoder = new TextEncoder();
        const bytes = encoder.encode('{"chunk":"héllo"}\n{"done":1}\n');
        const splitAt = 12; // inside the two-byte é sequence
        vi.stubGlobal('fetch', vi.fn(async () => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes.slice(0, splitAt));
                    controller.enqueue(bytes.slice(splitAt));
                    controller.close();
                }
            });
            return new Response(body, { status: 200 });
        }));
        const stub = __serverStreamStub('s_fn_00000001', 'utf8', '/_sigx/fn');
        await expect(collect(stub())).resolves.toEqual(['héllo']);
    });

    it('resolves the configureServerFn transport at call time', async () => {
        const mock = vi.fn(async () => ndjsonResponse('{"done":1}\n'));
        vi.stubGlobal('fetch', mock);
        configureServerFn({
            endpoint: 'https://api.example.com/_sigx/fn',
            headers: { authorization: 'Bearer abc' }
        });
        const stub = __serverStreamStub('s_fn_00000001', 'explain', '/_sigx/fn');
        await collect(stub());
        const [url, init] = mock.mock.calls[0] as unknown as [
            string,
            RequestInit & { headers: Record<string, string> }
        ];
        expect(url).toBe('https://api.example.com/_sigx/fn/s_fn_00000001');
        expect(init.headers.authorization).toBe('Bearer abc');
        expect(init.headers['content-type']).toBe('application/json');
    });

    it('.with({ headers }) merges over the transport headers (#448)', async () => {
        const mock = vi.fn(async () => ndjsonResponse('{"done":1}\n'));
        vi.stubGlobal('fetch', mock);
        configureServerFn({ headers: { authorization: 'Bearer abc', 'x-app': 'transport' } });
        const stub = __serverStreamStub('s_fn_00000001', 'explain', '/_sigx/fn');
        await collect(
            stub.with({
                headers: { 'x-app': 'per-call', 'x-trace-id': 't1', 'Content-Type': 'text/plain' }
            })()
        );
        const [, init] = mock.mock.calls[0] as unknown as [
            string,
            RequestInit & { headers: Record<string, string> }
        ];
        expect(init.headers.authorization).toBe('Bearer abc'); // transport survives
        expect(init.headers['x-app']).toBe('per-call'); // per-call wins
        expect(init.headers['x-trace-id']).toBe('t1');
        // content-type is never overridable, same rule as the fn stub's.
        expect(init.headers['content-type']).toBe('application/json');
        expect(init.headers['Content-Type']).toBeUndefined();
    });

    it("the caller's signal composes into the fetch signal (#448)", async () => {
        const outer = new AbortController();
        let observed: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            observed = init.signal as AbortSignal;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(encoder.encode('{"chunk":1}\n'));
                }
            });
            return new Response(body, { status: 200 });
        }));
        const stub = __serverStreamStub('s_fn_00000001', 'endless', '/_sigx/fn');
        for await (const chunk of stub.with({ signal: outer.signal })()) {
            expect(chunk).toBe(1);
            expect(observed?.aborted).toBe(false);
            // Mid-stream: nothing the stub does has aborted yet, so this
            // proves the CALLER's signal reached the fetch.
            outer.abort();
            expect(observed?.aborted).toBe(true);
            break;
        }
    });

    it('consumer break still aborts when an outer signal was supplied', async () => {
        const outer = new AbortController();
        let observed: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            observed = init.signal as AbortSignal;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(encoder.encode('{"chunk":1}\n'));
                }
            });
            return new Response(body, { status: 200 });
        }));
        const stub = __serverStreamStub('s_fn_00000001', 'endless', '/_sigx/fn');
        for await (const chunk of stub.with({ signal: outer.signal })()) {
            expect(chunk).toBe(1);
            break;
        }
        expect(observed?.aborted).toBe(true);
        expect(outer.signal.aborted).toBe(false); // the caller's signal is untouched
    });

    it('.with({ context }) dev-warns on the client — a stub sends nothing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse('{"done":1}\n')));
        const stub = __serverStreamStub('s_fn_00000001', 'explain', '/_sigx/fn');
        await collect(stub.with({ context: new Request('https://example.com/feed') })());
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('.with({ context }) is ignored on the client');
    });

    it('drops dangerous keys from streamed chunks', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            ndjsonResponse('{"chunk":{"__proto__":{"polluted":true},"ok":1}}\n{"done":1}\n')
        ));
        const stub = __serverStreamStub('s_fn_00000001', 'echo', '/_sigx/fn');
        await expect(collect(stub())).resolves.toEqual([{ ok: 1 }]);
    });
});

/* ------------------------------------------------------------------ */
/* composition                                                        */
/* ------------------------------------------------------------------ */

describe('serverStream — composition sanity', () => {
    it('a regular serverFn is unaffected by the stream branch', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const add = serverFn(async (_rq, a: number, b: number) => a + b);
        const res = await post(add, '{"args":[2,3]}');
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });
});

/* ------------------------------------------------------------------ */
/* unvalidated wire args (#412)                                       */
/* ------------------------------------------------------------------ */

describe('serverStream — unvalidated wire args (#412)', () => {
    it('warns once on a wire call with args, pointing at in-body validation', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = serverStream(async function* (_rq, upTo: number) {
            for (let i = 1; i <= upTo; i++) yield i;
        });
        await post(s, '{"args":[2]}');
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('serverStream'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('top of the generator'));
        await post(s, '{"args":[3]}');
        expect(warn).toHaveBeenCalledOnce();
    });

    it('does not warn for zero-arg wire calls or in-process iteration', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const zero = serverStream(async function* () {
            yield 'x';
        });
        await post(zero);
        const inProc = serverStream(async function* (_rq, upTo: number) {
            for (let i = 1; i <= upTo; i++) yield i;
        });
        await expect(collect(inProc(2))).resolves.toEqual([1, 2]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = serverStream(async function* (_rq, upTo: number) {
            yield upTo;
        });
        await post(s, '{"args":[2]}');
        expect(warn).not.toHaveBeenCalled();
    });
});
