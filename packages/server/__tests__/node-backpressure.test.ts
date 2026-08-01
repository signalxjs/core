/**
 * @vitest-environment node
 *
 * The Node adapter's response pump under backpressure (#568).
 *
 * `createServerFnHandler` streams `serverStream` bodies instead of buffering
 * them, so it has to respect `res.write()` returning false — and the wait for
 * `'drain'` is RACED against `'close'`, because a client that disconnects while
 * backpressured never emits `'drain'` and an unraced wait would pin the handler
 * forever. That race and the `reader.cancel()` on disconnect are three lines of
 * subtle code with no coverage; a regression in either is a hung request or a
 * server generator whose `finally` never runs.
 *
 * A real socket throughout, deliberately paused on the client side: nothing
 * short of that produces actual backpressure.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServerFnHandler } from '../src/node';
import { serverStream } from '../src/index';

/** Big enough that a paused client backpressures well before the end. */
const CHUNK = 'x'.repeat(256 * 1024);
const CHUNKS = 64;

const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.close();
        await once(server, 'close');
    }
});

interface Mounted {
    port: number;
    /** Resolves when the stream's `finally` ran — i.e. the source was closed. */
    finished: Promise<void>;
    /**
     * Resolves when the ADAPTER's own promise settles — the pump loop having
     * actually exited.
     *
     * This is the observation the race needs, and `finished` is not it: the
     * handler cancels the reader from a separate top-level `'close'` listener,
     * so the generator's `finally` runs whether or not the loop is still parked
     * on a `'drain'` that will never come. Deleting `res.once('close', settle)`
     * from the drain wait leaves every other assertion here green and hangs
     * this one — which is exactly the regression being guarded.
     */
    handlerSettled: Promise<void>;
}

/** Mount a big NDJSON stream and record whether its generator was finalized. */
async function mount(options: { throwAfter?: number } = {}): Promise<Mounted> {
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => (markFinished = resolve));

    const big = serverStream(async function* () {
        try {
            for (let i = 0; i < CHUNKS; i++) {
                if (options.throwAfter !== undefined && i === options.throwAfter) {
                    throw new Error('mid-stream failure');
                }
                yield `${i}:${CHUNK}`;
            }
        } finally {
            // Runs on normal completion AND on `reader.cancel()` — which is
            // exactly what the adapter must trigger when the client goes away.
            markFinished();
        }
    });

    let markSettled!: () => void;
    const handlerSettled = new Promise<void>((resolve) => (markSettled = resolve));

    const handler = createServerFnHandler({ functions: { big_fn_00000001: async () => big } });
    const server = createServer((req, res) => {
        void handler(req, res, () => {
            res.statusCode = 404;
            res.end('fallthrough');
        }).finally(markSettled);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { port: (server.address() as AddressInfo).port, finished, handlerSettled };
}

/** POST the stream with the raw client, so the response can be PAUSED. */
function post(port: number): ReturnType<typeof httpRequest> {
    const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/_sigx/fn/big_fn_00000001',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }
    });
    req.end(JSON.stringify({ args: [] }));
    return req;
}

describe('node adapter — streaming under backpressure (#568)', () => {
    it('delivers every chunk in order once the client resumes', async () => {
        const { port } = await mount();
        const req = post(port);
        const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream & { statusCode: number }];
        expect(res.statusCode).toBe(200);

        // Pause immediately: the kernel buffer fills, `res.write()` starts
        // returning false, and the handler parks on the drain/close race.
        res.pause();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const body = await new Promise<string>((resolve, reject) => {
            let text = '';
            res.on('data', (c: Buffer) => (text += c.toString()));
            res.on('end', () => resolve(text));
            res.on('error', reject);
            res.resume();
        });

        // NDJSON: one JSON line per yield, then the `{"done":1}` terminator.
        // Every chunk, in order, intact — a drain listener that fired once and
        // stopped, or a wait that resolved early, shows up here as truncation,
        // and a lost terminator would leave a real client's iterator hanging.
        const lines = body.trim().split('\n');
        expect(lines).toHaveLength(CHUNKS + 1);
        expect(JSON.parse(lines[CHUNKS])).toEqual({ done: 1 });
        lines.slice(0, CHUNKS).forEach((line, i) => {
            const parsed = JSON.parse(line) as { chunk?: string };
            expect(parsed.chunk?.startsWith(`${i}:`)).toBe(true);
            expect(parsed.chunk).toHaveLength(String(i).length + 1 + CHUNK.length);
        });
    }, 30_000);

    it('a client that disconnects WHILE backpressured cancels the source', async () => {
        const { port, finished } = await mount();
        const req = post(port);
        const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream];
        res.pause();
        await new Promise((resolve) => setTimeout(resolve, 50));
        req.destroy();

        // `reader.cancel()` ran, so the server generator's `finally` did too.
        await expect(finished).resolves.toBeUndefined();
    }, 30_000);

    it('…and the pump loop EXITS rather than waiting for a drain that never comes', async () => {
        const { port, handlerSettled } = await mount();
        const req = post(port);
        const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream];
        // Park the handler in the backpressure wait, then vanish. A wait on
        // 'drain' alone never settles for a client that is already gone, and
        // the request handler stays pinned for the life of the process.
        res.pause();
        await new Promise((resolve) => setTimeout(resolve, 50));
        req.destroy();

        await expect(handlerSettled).resolves.toBeUndefined();
    }, 30_000);

    it('a stream that fails after the client left produces no unhandled rejection', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on('unhandledRejection', onRejection);
        try {
            const { port, finished } = await mount({ throwAfter: 2 });
            const req = post(port);
            const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream];
            res.pause();
            await new Promise((resolve) => setTimeout(resolve, 50));
            req.destroy();
            await finished;
            // `reader.cancel()` rejects when the stream already errored; the
            // adapter swallows that deliberately. Give the microtask queue and
            // one macrotask a chance to surface it if it did not.
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(rejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    }, 30_000);
});
