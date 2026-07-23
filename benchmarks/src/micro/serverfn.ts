/**
 * `@sigx/server` — the RPC endpoint, in process.
 *
 * `handleServerFnRequest` is Request in, Response out, so the whole pipeline
 * (method/media-type/Origin checks, body read, JSON parse with the
 * prototype-pollution reviver, wire revive, guard, handler, wire encode,
 * stringify) is measurable without a socket. Everything here builds a fresh
 * `Request` per iteration, because a body can only be consumed once — the
 * floor pays exactly the same construction cost, which is why the floor is
 * expressed as a ratio and not subtracted.
 *
 * Floor: a bare fetch handler that reads the body, `JSON.parse`s it, and
 * answers `JSON.stringify(result)`. That is the irreducible work of "accept
 * JSON, return JSON"; everything above it is what the endpoint's contract
 * costs.
 *
 * H3: the endpoint walks every result twice — `encodeWire`'s tree walk, then
 * `JSON.stringify`. The `plainList` read against its floor is where that
 * shows up.
 */
import { serverFn, serverStream, ServerFnError } from '@sigx/server';
import { handleServerFnRequest } from '@sigx/server/server';
import { assert, type MicroBench, type MicroSuite } from './types.ts';
import { plainList, richPayload, smallArgs } from '../fixtures/payloads.ts';

const ORIGIN = 'http://localhost';
const BASE = `${ORIGIN}/_sigx/fn`;

// --- the functions under test ------------------------------------------------

const readRows = serverFn(async () => plainList);
const readRich = serverFn(async () => richPayload);
const mutate = serverFn(async (_rq, input: { id: number; qty: number }) => ({
    ok: true,
    id: input.id,
    qty: input.qty
}));
const cachedRead = serverFn({
    cache: { maxAge: 60 },
    handler: async () => plainList.slice(0, 50)
});
const failing = serverFn(async () => {
    throw new ServerFnError(422, 'nope', { field: 'qty' });
});
const streamRows = serverStream(async function* () {
    for (let i = 0; i < 1000; i++) yield { i, name: plainList[i % plainList.length].name };
});

const REGISTRY: Record<string, unknown> = {
    readRows_fn_00000001: readRows,
    readRich_fn_00000002: readRich,
    mutate_fn_00000003: mutate,
    cachedRead_fn_00000004: cachedRead,
    failing_fn_00000005: failing,
    streamRows_fn_00000006: streamRows
};

const options = { resolve: (symbol: string) => REGISTRY[symbol] ?? null };

// --- request construction ----------------------------------------------------

function post(symbol: string, args: unknown[]): Request {
    return new Request(`${BASE}/${symbol}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ args })
    });
}

function get(symbol: string, args: unknown[]): Request {
    const query = `?args=${encodeURIComponent(JSON.stringify(args))}`;
    return new Request(`${BASE}/${symbol}${query}`, { method: 'GET' });
}

/** The floor: accept JSON, answer JSON, no contract. */
async function floorHandler(request: Request, result: unknown): Promise<Response> {
    const body = await request.text();
    const parsed = JSON.parse(body) as { args?: unknown[] };
    void parsed.args;
    return new Response(JSON.stringify({ data: result }), {
        headers: { 'content-type': 'application/json' }
    });
}

// --- guards ------------------------------------------------------------------

/** A 415/403/404 would benchmark the reject path at flattering speed. */
async function expectOk(response: Response, rows: number): Promise<void> {
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const envelope = (await response.json()) as { data?: unknown[] };
    assert(Array.isArray(envelope.data), 'envelope carried no data array');
    assert(envelope.data.length === rows, `expected ${rows} rows, got ${envelope.data.length}`);
}

async function drain(response: Response): Promise<number> {
    const reader = response.body!.getReader();
    let bytes = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
    }
    return bytes;
}

export const serverFnSuite: MicroSuite = {
    name: 'serverfn',
    benches(): MicroBench[] {
        return [
            // --- a read of 1 000 rows, against its floor (H3) ---------------
            {
                suite: 'serverfn',
                name: 'POST read 1k rows (floor)',
                isFloor: true,
                check: async () => {
                    const res = await floorHandler(post('readRows_fn_00000001', []), plainList);
                    await expectOk(res, plainList.length);
                },
                run: () => floorHandler(post('readRows_fn_00000001', []), plainList)
            },
            {
                suite: 'serverfn',
                name: 'POST read 1k rows',
                floorOf: 'POST read 1k rows (floor)',
                quick: true,
                check: async () => {
                    const res = await handleServerFnRequest(post('readRows_fn_00000001', []), options);
                    await expectOk(res, plainList.length);
                },
                run: () => handleServerFnRequest(post('readRows_fn_00000001', []), options)
            },
            {
                suite: 'serverfn',
                name: 'POST read rich payload',
                check: async () => {
                    const res = await handleServerFnRequest(post('readRich_fn_00000002', []), options);
                    await expectOk(res, richPayload.length);
                },
                run: () => handleServerFnRequest(post('readRich_fn_00000002', []), options)
            },

            // --- fixed per-call overhead ------------------------------------
            {
                suite: 'serverfn',
                name: 'POST mutation, tiny args (floor)',
                isFloor: true,
                check: async () => {
                    const res = await floorHandler(post('mutate_fn_00000003', smallArgs), { ok: true });
                    assert(res.status === 200, `expected 200, got ${res.status}`);
                },
                run: () => floorHandler(post('mutate_fn_00000003', smallArgs), { ok: true })
            },
            {
                suite: 'serverfn',
                name: 'POST mutation, tiny args',
                floorOf: 'POST mutation, tiny args (floor)',
                check: async () => {
                    const res = await handleServerFnRequest(post('mutate_fn_00000003', smallArgs), options);
                    assert(res.status === 200, `expected 200, got ${res.status}`);
                    const envelope = (await res.json()) as { data?: { id?: number } };
                    assert(envelope.data?.id === 42, 'mutation did not echo its input');
                },
                run: () => handleServerFnRequest(post('mutate_fn_00000003', smallArgs), options)
            },

            // --- the §4.1 GET read path -------------------------------------
            {
                suite: 'serverfn',
                name: 'GET idempotent read',
                check: async () => {
                    const res = await handleServerFnRequest(get('cachedRead_fn_00000004', []), options);
                    assert(res.status === 200, `expected 200, got ${res.status}`);
                    assert(
                        res.headers.get('cache-control') === 'private, max-age=60',
                        `expected the precomputed Cache-Control, got "${res.headers.get('cache-control')}"`
                    );
                    await expectOk(res, 50);
                },
                run: () => handleServerFnRequest(get('cachedRead_fn_00000004', []), options)
            },

            // --- the §5 masking branch --------------------------------------
            {
                suite: 'serverfn',
                name: 'POST error path (ServerFnError)',
                check: async () => {
                    const res = await handleServerFnRequest(post('failing_fn_00000005', []), options);
                    assert(res.status === 422, `expected 422, got ${res.status}`);
                },
                run: () => handleServerFnRequest(post('failing_fn_00000005', []), options)
            },

            // --- NDJSON streaming (§6.1) ------------------------------------
            {
                suite: 'serverfn',
                name: 'NDJSON stream, 1000 chunks',
                check: async () => {
                    const res = await handleServerFnRequest(post('streamRows_fn_00000006', []), options);
                    assert(res.status === 200, `expected 200, got ${res.status}`);
                    assert(
                        res.headers.get('content-type') === 'application/x-ndjson',
                        'stream did not answer as NDJSON'
                    );
                    assert((await drain(res)) > 10_000, 'stream produced suspiciously few bytes');
                },
                run: async () => {
                    const res = await handleServerFnRequest(post('streamRows_fn_00000006', []), options);
                    return drain(res);
                }
            }
        ];
    }
};

/**
 * The stream's time-to-first-byte, measured separately from throughput —
 * `pull()` only runs as the consumer reads, so a whole-stream bench hides
 * where the latency is. Nanoseconds, one sample per call.
 */
export async function streamTtfbNs(): Promise<{ ttfbNs: bigint; totalNs: bigint; bytes: number }> {
    const start = process.hrtime.bigint();
    const res = await handleServerFnRequest(post('streamRows_fn_00000006', []), options);
    const reader = res.body!.getReader();
    let ttfb = 0n;
    let bytes = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (ttfb === 0n) ttfb = process.hrtime.bigint() - start;
        bytes += value.byteLength;
    }
    return { ttfbNs: ttfb, totalNs: process.hrtime.bigint() - start, bytes };
}
