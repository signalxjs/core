/**
 * @vitest-environment node
 *
 * The app pipeline (rfc-server-v4 §1.3/§2): middleware → authenticate →
 * identity gate → arity → validation → authorize → handler, resolved
 * through the fail-closed `__SIGX_SERVER_APP__` seam. These are the
 * revision's executable pins:
 *
 *  - the total order, on the in-process path (the one transport v3's
 *    endpoint guard never covered — middleware DOES run for an in-process
 *    call, the inverse of the retired "endpoint guard is wire-only" pin);
 *  - the ownership contract (a wire-shaped invoke does NOT re-run the
 *    prelude — the transport owns it);
 *  - fail-closed misses (no app configured ⇒ a bare fn denies 401, an
 *    `allowAnonymous` fn runs);
 *  - authentication memoized once per request store;
 *  - authenticator throws propagate as errors, never as denies.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    serverFn,
    serverStream,
    ServerFnError,
    isServerFnError,
    principal,
    requirePrincipal,
    setPrincipal,
    type ServerFnContext,
    type StandardSchemaV1
} from '../src/index';
import { runServerPrelude } from '../src/app-config';
import { createTestServerFnContext, stubServerApp } from '../src/testing';

let restore: (() => void) | undefined;
afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
});

describe('the pipeline order (rfc-server-v4 §1.3)', () => {
    it('middleware → authenticate → gate → validate → authorize → handler, in-process', async () => {
        const order: string[] = [];
        restore = stubServerApp({
            middleware: [
                async (_rq, fn) => {
                    order.push(`mw-a:${fn.transport}`);
                },
                async () => {
                    order.push('mw-b');
                }
            ],
            authenticate: () => {
                order.push('authenticate');
                return { id: 'u1' };
            }
        });
        const fn = serverFn({
            authorize: () => {
                order.push('authorize');
                return true;
            },
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate(value) {
                        order.push('validate');
                        return { value: value as string };
                    }
                }
            } satisfies StandardSchemaV1<string>,
            handler: async (_rq, input) => {
                order.push('handler');
                return input;
            }
        });
        await expect(fn('x')).resolves.toBe('x');
        expect(order).toEqual([
            'mw-a:in-process',
            'mw-b',
            'authenticate',
            'validate',
            'authorize',
            'handler'
        ]);
    });

    it('middleware DOES run for an in-process call — the inverse of the retired wire-only pin', async () => {
        // rfc-server-v3 §4 pinned "the endpoint guard does NOT run for an
        // in-process call"; v4 §3.1 replaces that mechanism with app
        // middleware, whose whole point is reaching this path.
        const ran: string[] = [];
        restore = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    ran.push(fn.transport);
                }
            ],
            authenticate: () => ({ id: 'u1' })
        });
        const fn = serverFn(async () => 'ok');
        await expect(fn()).resolves.toBe('ok');
        expect(ran).toEqual(['in-process']);
    });

    it('a wire-shaped invoke does NOT re-run the prelude — the transport owns steps 1–3', async () => {
        const middleware = vi.fn();
        restore = stubServerApp({
            middleware: [middleware],
            authenticate: () => ({ id: 'u1' })
        });
        const fn = serverFn({ handler: async () => 'ok' });
        const ctx = createTestServerFnContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        await expect(
            fn.__sigxFn(ctx, { symbol: 'x_fn_1', name: 'x', transport: 'wire' }, [])
        ).resolves.toBe('ok');
        // The endpoint would have run it before invoke; invoke itself must
        // not, or middleware doubles on every wire call.
        expect(middleware).not.toHaveBeenCalled();
    });

    it('a throwing middleware vetoes before validation ever runs', async () => {
        const validate = vi.fn();
        restore = stubServerApp({
            middleware: [
                () => {
                    throw new ServerFnError(429, 'slow down');
                }
            ],
            authenticate: () => ({ id: 'u1' })
        });
        const fn = serverFn({
            input: {
                '~standard': { version: 1, vendor: 'test', validate }
            } as unknown as StandardSchemaV1<string>,
            handler: async () => 'never'
        });
        const error = await fn('x').catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(429);
        expect(validate).not.toHaveBeenCalled();
    });
});

describe('fail-closed misses (rfc-server-v4 §2.1)', () => {
    it('no app configured: a bare fn denies 401 before validation', async () => {
        const validate = vi.fn();
        const fn = serverFn({
            input: {
                '~standard': { version: 1, vendor: 'test', validate }
            } as unknown as StandardSchemaV1<string>,
            handler: async () => 'never'
        });
        const error = await fn('x').catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
        expect((error as ServerFnError).message).toBe('Authentication required');
        expect(validate).not.toHaveBeenCalled();
    });

    it('an app with no authenticate still denies — the principal is null', async () => {
        restore = stubServerApp({});
        const fn = serverFn({ handler: async () => 'never' });
        const error = await fn().catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(401);
    });

    it('an authenticate returning null denies non-allowAnonymous fns', async () => {
        restore = stubServerApp({ authenticate: () => null });
        const fn = serverFn({ handler: async () => 'never' });
        const error = await fn().catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(401);
    });

    it('a throwing authenticator is an ERROR, never a deny — even for allowAnonymous fns', async () => {
        restore = stubServerApp({
            authenticate: () => {
                throw new Error('session store down');
            }
        });
        const open = serverFn({ allowAnonymous: true, handler: async () => 'never' });
        await expect(open()).rejects.toThrow('session store down');
    });
});

describe('authentication is memoized once per request store (rfc-server-v4 §1.3)', () => {
    it('two calls sharing one context authenticate once; separate calls, separately', async () => {
        const authenticate = vi.fn(() => ({ id: 'u1' }));
        restore = stubServerApp({ authenticate });
        const fn = serverFn({ handler: async (rq) => (await principal<{ id: string }>(rq))?.id });

        const shared = createTestServerFnContext();
        await expect(fn.with({ context: shared })()).resolves.toBe('u1');
        await expect(fn.with({ context: shared })()).resolves.toBe('u1');
        expect(authenticate).toHaveBeenCalledOnce();

        await fn.with({ context: createTestServerFnContext() })();
        expect(authenticate).toHaveBeenCalledTimes(2);
    });

    it('racing first touches share ONE resolution — the promise is the memo', async () => {
        let resolves = 0;
        restore = stubServerApp({
            authenticate: async () => {
                resolves += 1;
                await new Promise((r) => setTimeout(r, 5));
                return { id: 'u1' };
            }
        });
        const fn = serverFn({ handler: async () => 'ok' });
        const shared = createTestServerFnContext();
        await Promise.all([
            fn.with({ context: shared })(),
            fn.with({ context: shared })(),
            fn.with({ context: shared })()
        ]);
        expect(resolves).toBe(1);
    });

    it('a seeded principal wins: authenticate never runs (the correct unit-test shape)', async () => {
        const authenticate = vi.fn(() => ({ id: 'from-cookie' }));
        restore = stubServerApp({ authenticate });
        const fn = serverFn({
            handler: async (rq) => (await requirePrincipal<{ id: string }>(rq)).id
        });
        const ctx = createTestServerFnContext(undefined, { principal: { id: 'seeded' } });
        await expect(fn.with({ context: ctx })()).resolves.toBe('seeded');
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('setPrincipal(null) pins the anonymous path explicitly', async () => {
        restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
        const fn = serverFn({ handler: async () => 'never' });
        const ctx = createTestServerFnContext();
        setPrincipal(ctx, null);
        const error = await fn.with({ context: ctx })().catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(401);
    });
});

describe('the principal accessors', () => {
    it('principal() is null with no app; requirePrincipal() throws the 401', async () => {
        const ctx = createTestServerFnContext();
        await expect(principal(ctx)).resolves.toBeNull();
        const error = await requirePrincipal(ctx).catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
    });
});

describe('serverStream rides the same pipeline (rfc-server-v4 §1.3)', () => {
    it('prelude + authorize run before the first chunk; a veto surfaces on first pull', async () => {
        const order: string[] = [];
        restore = stubServerApp({
            middleware: [
                () => {
                    order.push('mw');
                }
            ],
            authenticate: () => {
                order.push('authenticate');
                return { id: 'u1' };
            }
        });
        const stream = serverStream({
            authorize: () => {
                order.push('authorize');
                return true;
            },
            handler: async function* () {
                order.push('chunk');
                yield 'a';
            }
        });
        // Iteration NOT started yet — nothing has run.
        const iterable = stream();
        expect(order).toEqual([]);
        for await (const chunk of iterable) expect(chunk).toBe('a');
        expect(order).toEqual(['mw', 'authenticate', 'authorize', 'chunk']);
    });

    it('a bare stream denies on first pull with no app configured', async () => {
        const stream = serverStream(async function* () {
            yield 'never';
        });
        const error = await (async () => {
            for await (const chunk of stream()) void chunk;
        })().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
    });

    it('the single-input form hands the VALIDATED input to policies', async () => {
        const seen: unknown[] = [];
        restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
        const stream = serverStream({
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (value: unknown) => ({ value: String(value).toUpperCase() })
                }
            },
            authorize: (_p, _rq, op) => {
                seen.push(op.input);
                return true;
            },
            handler: async function* (_rq, input: string) {
                yield input;
            }
        });
        for await (const chunk of stream('abc' as never)) expect(chunk).toBe('ABC');
        expect(seen).toEqual(['ABC']);
    });
});

describe('the unconfigured-deny dev hint (once per process)', () => {
    it('names createServerApp and the testing remedy', async () => {
        // The latch is module state, so this test observes it EITHER firing
        // here or having fired in an earlier test of this run — assert on
        // the message only if it fires now, and never assert it fires twice.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async () => 'never' });
        await fn().catch(() => {});
        await fn().catch(() => {});
        const hints = warn.mock.calls.filter(([m]) =>
            String(m).includes('no server app is configured')
        );
        expect(hints.length).toBeLessThanOrEqual(1);
        if (hints.length === 1) {
            expect(String(hints[0][0])).toContain('createServerApp');
            expect(String(hints[0][0])).toContain('createTestServerFnContext');
        }
    });
});

describe('runServerPrelude — the endpoint-facing half (ownership contract)', () => {
    it('runs middleware with the wire info and 401s a null principal unless anonymous', async () => {
        const ran: string[] = [];
        restore = stubServerApp({
            middleware: [
                (_rq: ServerFnContext, fn) => {
                    ran.push(`${fn.symbol}:${fn.transport}`);
                }
            ]
        });
        const ctx = createTestServerFnContext();
        const info = { symbol: 'x_fn_1', name: 'x', transport: 'wire' } as const;
        await expect(runServerPrelude(ctx, info, true)).resolves.toBeUndefined();
        const error = await runServerPrelude(createTestServerFnContext(), info, false).catch(
            (e: unknown) => e
        );
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
        expect(ran).toEqual(['x_fn_1:wire', 'x_fn_1:wire']);
    });
});
