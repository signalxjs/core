/**
 * @vitest-environment node
 *
 * In-process request context (rfc-server §7 v1.1): the explicit
 * `.with({ context })` channel (#352) and the ambient AsyncLocalStorage
 * form (#309).
 *
 * The failure both address: a server function shaped
 * `sessionFrom(rq.request)` works over RPC and throws the moment the same
 * function is called during SSR.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { serverFn, serverStream } from '../src/index';
import { runWithServerFnContext } from '../src/node';

const REQ = (url = 'https://example.com/cart', init?: RequestInit) => new Request(url, init);

/** The canonical shape: reads the request, like any auth helper would. */
const whoAmI = serverFn(async (rq) => rq.request.headers.get('cookie') ?? null);
const whereAmI = serverFn(async (rq) => rq.url.pathname);

afterEach(() => {
    delete (globalThis as any).__SIGX_SERVERFN_CONTEXT__;
    vi.restoreAllMocks();
});

describe('detached context — the default', () => {
    it('throws descriptively on rq.request with no context supplied', async () => {
        await expect(whoAmI()).rejects.toThrow(/not available on an in-process/);
    });

    it('throws on rq.url too', async () => {
        await expect(whereAmI()).rejects.toThrow(/rq\.url/);
    });
});

describe('explicit context — fn.with({ context }) (#352)', () => {
    it('supplies the request to an in-process call', async () => {
        const req = REQ('https://example.com/cart', { headers: { cookie: 'session=alice' } });
        await expect(whoAmI.with({ context: req })()).resolves.toBe('session=alice');
    });

    it('derives rq.url from the supplied request', async () => {
        await expect(whereAmI.with({ context: REQ('https://example.com/checkout') })()).resolves.toBe(
            '/checkout'
        );
    });

    it('accepts a partial context, not just a Request', async () => {
        const locals = { user: 'bob' };
        const readsLocals = serverFn(async (rq) => rq.locals.user);
        await expect(readsLocals.with({ context: { locals } })()).resolves.toBe('bob');
    });

    it('still honors the signal option alongside context', async () => {
        const controller = new AbortController();
        const readsSignal = serverFn(async (rq) => rq.abortSignal.aborted);
        controller.abort();
        await expect(
            readsSignal.with({ context: REQ(), signal: controller.signal })()
        ).resolves.toBe(true);
    });

    it('leaves rq.status() inert — there is no HTTP response to affect', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const setsStatus = serverFn(async (rq) => {
            rq.status(418);
            return 'ok';
        });
        await expect(setsStatus.with({ context: REQ() })()).resolves.toBe('ok');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('inert'));
    });
});

describe('ambient context — runWithServerFnContext (#309)', () => {
    it('makes rq.request available to a call nested anywhere inside', async () => {
        const req = REQ('https://example.com/cart', { headers: { cookie: 'session=carol' } });
        const result = await runWithServerFnContext(req, async () => {
            // Deliberately several awaits deep: this is what ALS buys over
            // threading a parameter through user code.
            await Promise.resolve();
            const inner = async () => whoAmI();
            return inner();
        });
        expect(result).toBe('session=carol');
    });

    it('does not leak outside the scope', async () => {
        await runWithServerFnContext(REQ(), () => whoAmI());
        await expect(whoAmI()).rejects.toThrow(/not available on an in-process/);
    });

    it('keeps concurrent scopes isolated', async () => {
        const one = runWithServerFnContext(
            REQ('https://example.com/a', { headers: { cookie: 'session=one' } }),
            async () => {
                await new Promise((r) => setTimeout(r, 5));
                return whoAmI();
            }
        );
        const two = runWithServerFnContext(
            REQ('https://example.com/b', { headers: { cookie: 'session=two' } }),
            () => whoAmI()
        );
        expect(await Promise.all([one, two])).toEqual(['session=one', 'session=two']);
    });

    it('reaches serverStream too, which has no .with() channel', async () => {
        const tail = serverStream(async function* (rq) {
            yield rq.url.pathname;
        });
        const out = await runWithServerFnContext(REQ('https://example.com/feed'), async () => {
            const chunks: unknown[] = [];
            for await (const c of tail()) chunks.push(c);
            return chunks;
        });
        expect(out).toEqual(['/feed']);
    });
});

describe('precedence — explicit beats ambient', () => {
    it('uses the .with({ context }) request inside an ambient scope', async () => {
        const ambient = REQ('https://example.com/a', { headers: { cookie: 'session=ambient' } });
        const explicit = REQ('https://example.com/b', { headers: { cookie: 'session=explicit' } });
        const got = await runWithServerFnContext(ambient, () =>
            whoAmI.with({ context: explicit })()
        );
        expect(got).toBe('session=explicit');
    });
});

describe('a broken ambient provider degrades to the detached throw', () => {
    it('does not surface the provider error', async () => {
        (globalThis as any).__SIGX_SERVERFN_CONTEXT__ = () => {
            throw new Error('provider exploded');
        };
        // The descriptive detached error is a better failure than a leaked
        // internal one — and it is what the author can act on.
        await expect(whoAmI()).rejects.toThrow(/not available on an in-process/);
    });
});
