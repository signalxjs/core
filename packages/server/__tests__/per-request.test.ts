/**
 * @vitest-environment node
 *
 * perRequest() and the shared per-request store (rfc-server-v3 §2.3-2.5,
 * #494) — one value per request/render instead of one per call, memoized
 * promise included, reachable from every guard and handler on every transport.
 */

import { describe, it, expect, vi } from 'vitest';
import { perRequest, serverFn, ServerFnError, type ServerFnContext } from '../src/index';
import { handleServerFnRequest } from '../src/server/index';
import { runInScope } from '../src/scope';
import { createDetachedContext } from '../src/context';

const ORIGIN = 'http://localhost';

const post = (symbol: string, args: unknown[] = []): Request =>
    new Request(`${ORIGIN}/_sigx/fn/${symbol}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ args })
    });

/** A scope source shaped like what `createRequestHandler` hands over. */
const nodeRequest = (url = '/board'): Record<string, unknown> => ({
    url,
    method: 'GET',
    headers: { host: 'app.test', cookie: 'sid=alice' },
    socket: { encrypted: false }
});

describe('perRequest — one value per request', () => {
    it('is computed ONCE across many in-process calls in one render', async () => {
        let decodes = 0;
        const session = perRequest(async (rq) => {
            decodes += 1;
            return rq.request.headers.get('cookie');
        });

        // Three cells, as a page with three useData reads would have.
        const a = serverFn(async (rq) => session(rq));
        const b = serverFn(async (rq) => session(rq));
        const c = serverFn(async (rq) => session(rq));

        const seen = await runInScope(nodeRequest(), async () =>
            Promise.all([a(), b(), c()])
        );
        expect(seen).toEqual(['sid=alice', 'sid=alice', 'sid=alice']);
        expect(decodes).toBe(1);
    });

    it('is never shared across two concurrent renders', async () => {
        let decodes = 0;
        const who = perRequest(async (rq) => {
            decodes += 1;
            return rq.url.pathname;
        });
        const read = serverFn(async (rq) => who(rq));

        const [one, two] = await Promise.all([
            runInScope(nodeRequest('/one'), () => read()),
            runInScope(nodeRequest('/two'), () => read())
        ]);
        expect([one, two]).toEqual(['/one', '/two']);
        expect(decodes).toBe(2);
    });

    it('gives a guard and a handler racing on first touch ONE in-flight promise', async () => {
        let starts = 0;
        const session = perRequest(async () => {
            starts += 1;
            await Promise.resolve();
            return 'decoded';
        });

        const promises: unknown[] = [];
        const fn = serverFn({
            use: [
                (rq): void => {
                    promises.push(session(rq));
                }
            ],
            handler: async (rq) => {
                promises.push(session(rq));
                return 'ok';
            }
        });

        await runInScope(nodeRequest(), () => fn());
        expect(starts).toBe(1);
        // The same promise OBJECT, not merely an equal value — the memo is the
        // promise, so there is never a second code path.
        expect(promises[0]).toBe(promises[1]);
    });

    it('is shared across the wire path, and not across two wire requests', async () => {
        let decodes = 0;
        const session = perRequest(async (rq) => {
            decodes += 1;
            return rq.request.headers.get('origin');
        });
        const fn = serverFn({
            use: [
                async (rq): Promise<void> => {
                    await session(rq);
                }
            ],
            handler: async (rq) => session(rq)
        });

        const first = await handleServerFnRequest(post('s_fn_1'), { resolve: () => fn });
        await expect(first.json()).resolves.toEqual({ data: ORIGIN });
        expect(decodes).toBe(1);

        await handleServerFnRequest(post('s_fn_1'), { resolve: () => fn });
        expect(decodes).toBe(2);
    });

    it('composes with no API at all — one setup calls another', async () => {
        let decodes = 0;
        const session = perRequest(async (rq) => {
            decodes += 1;
            return { token: rq.request.headers.get('cookie') };
        });
        const client = perRequest(async (rq) => `client(${(await session(rq)).token})`);

        const fn = serverFn(async (rq) => [await client(rq), (await session(rq)).token]);
        await expect(runInScope(nodeRequest(), () => fn())).resolves.toEqual([
            'client(sid=alice)',
            'sid=alice'
        ]);
        expect(decodes).toBe(1);
    });
});

describe('perRequest — memoization semantics', () => {
    const ctx = (): ServerFnContext => createDetachedContext();

    it('keeps a rejected setup rejected for THIS request', async () => {
        let attempts = 0;
        const session = perRequest(async () => {
            attempts += 1;
            throw new ServerFnError(401, 'no session');
        });
        const rq = ctx();

        const first = await session(rq).catch((e: unknown) => e);
        const second = await session(rq).catch((e: unknown) => e);
        // The same error instance: retrying a failed decode once per cell
        // would be a footgun, not a feature.
        expect(second).toBe(first);
        expect(attempts).toBe(1);
    });

    it('is sticky for a SYNCHRONOUS throw too, and reports the real error', () => {
        let attempts = 0;
        const boom = perRequest(() => {
            attempts += 1;
            throw new Error('config missing');
        });
        const rq = ctx();

        expect(() => boom(rq)).toThrow('config missing');
        // Not "circular request value" — the sentinel is cleared on the way out.
        expect(() => boom(rq)).toThrow('config missing');
        expect(attempts).toBe(1);
    });

    it('throws on re-entrancy rather than memoizing undefined', () => {
        // eslint-disable-next-line prefer-const
        let self: (rq: ServerFnContext) => unknown;
        self = perRequest((rq) => self(rq));
        expect(() => self(ctx())).toThrow(/circular request value/);
    });

    it('memoizes per call when nothing supplies a shared store', async () => {
        let decodes = 0;
        const value = perRequest(async () => {
            decodes += 1;
            return 'v';
        });
        // A detached context has its own fresh `locals`, so two of them are two
        // requests — which is how a unit test isolates calls with no ceremony.
        await value(ctx());
        await value(ctx());
        expect(decodes).toBe(2);
    });

    it('does not require a request — a setup that never reads one works detached', async () => {
        const constant = perRequest(async () => 42);
        await expect(constant(ctx())).resolves.toBe(42);
    });

    it('__DEV__: calling it without a context names the remedy', () => {
        const value = perRequest(async () => 1);
        expect(() => value(undefined as unknown as ServerFnContext)).toThrow(
            /called without a request context/
        );
    });
});

describe('perRequest — the store stays out of the way', () => {
    it('does not survive enumeration: keys, spread or JSON of locals', async () => {
        const value = perRequest(async () => 'v');
        const rq = createDetachedContext();
        await value(rq);

        expect(Object.keys(rq.locals)).toEqual([]);
        // The slot is a SYMBOL key, so it was never in `Object.keys`; the
        // non-enumerable flag is what keeps it out of a spread, which copies
        // own enumerable symbols too.
        expect(Object.getOwnPropertySymbols({ ...rq.locals })).toEqual([]);
        expect(JSON.stringify(rq.locals)).toBe('{}');
        // …and a user-written local is unaffected.
        rq.locals.user = 'alice';
        expect(JSON.stringify(rq.locals)).toBe('{"user":"alice"}');
        expect({ ...rq.locals }).toEqual({ user: 'alice' });
    });

    it('is still reachable by deliberate reflection — hidden, not private', async () => {
        // Stated rather than asserted-away: `Object.getOwnPropertySymbols`
        // reports non-enumerable keys, so the slot is visible to code that
        // goes looking. The guarantee is only that ordinary handling of
        // `locals` — logging, spreading, serializing — never trips over it.
        const value = perRequest(async () => 'v');
        const rq = createDetachedContext();
        await value(rq);
        expect(Object.getOwnPropertySymbols(rq.locals)).toEqual([
            Symbol.for('sigx.serverfn.requestValues')
        ]);
    });
});

describe('perRequest — .with({ context }) (the locked §2.4 rule)', () => {
    it('shares one store for the SAME context object, and not for a fresh Request', async () => {
        let decodes = 0;
        const session = perRequest(async () => {
            decodes += 1;
            return 'decoded';
        });
        const fn = serverFn(async (rq) => session(rq));

        const shared = { request: new Request('https://x.test/'), locals: {} };
        await fn.with({ context: shared })();
        await fn.with({ context: shared })();
        expect(decodes).toBe(1);

        // A fresh Request per call is its own store — the framework-free way
        // to isolate two calls in a test.
        await fn.with({ context: new Request('https://x.test/') })();
        await fn.with({ context: new Request('https://x.test/') })();
        expect(decodes).toBe(3);
    });
});

describe('perRequest — no AsyncLocalStorage (workerd without nodejs_compat)', () => {
    it('degrades to per-invocation sharing; explicit rq still works, nothing splits', async () => {
        vi.resetModules();
        vi.doMock('node:async_hooks', () => {
            throw new Error('unavailable');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const scope = await import('../src/scope');
            const api = await import('../src/index');

            let decodes = 0;
            const session = api.perRequest(async () => {
                decodes += 1;
                return 'decoded';
            });

            // The guards and the handler of ONE invocation receive the same
            // `rq`, so the guard's decode is still the handler's decode.
            let fromGuard: unknown;
            const fn = api.serverFn({
                use: [
                    async (rq): Promise<void> => {
                        fromGuard = await session(rq);
                    }
                ],
                handler: async (rq) => session(rq)
            });

            // Runs UNSCOPED — that is a supported state, not an error.
            await expect(scope.runInScope(nodeRequest(), () => fn())).resolves.toBe('decoded');
            expect(fromGuard).toBe('decoded');
            expect(decodes).toBe(1);

            // The discriminator: WITH an ALS, two in-process calls inside one
            // scope share the store, so this stays 1. Without one there is no
            // store to share and each call re-derives — exactly as it did
            // before this feature existed, which is the degradation the RFC
            // calls a supported state rather than an error.
            await scope.runInScope(nodeRequest(), async () => {
                await fn();
                await fn();
            });
            expect(decodes).toBe(3);
        } finally {
            warn.mockRestore();
            vi.doUnmock('node:async_hooks');
            vi.resetModules();
        }
    });
});
