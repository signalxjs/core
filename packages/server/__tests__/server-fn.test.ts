/**
 * @vitest-environment node
 *
 * serverFn() — the wrapper pipeline (rfc-server §2): direct and options
 * forms, `use` guards, `input` validation, and the detached in-process
 * context.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { serverFn, ServerFnError, isServerFnError, type StandardSchemaV1 } from '../src/index';
import { createRequestContext } from '../src/context';

afterEach(() => {
    vi.restoreAllMocks();
});

/** Minimal standard-schema: requires { id: string }. */
const schema: StandardSchemaV1<{ id: string }> = {
    '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
            const id = (value as { id?: unknown })?.id;
            if (typeof id !== 'string') {
                return { issues: [{ message: 'id must be a string' }] };
            }
            return { value: { id } };
        }
    }
};

describe('serverFn — direct form', () => {
    it('is a plain async function stamped with the invoke pipeline', async () => {
        const fn = serverFn(async (_rq, a: number, b: number) => a + b);
        expect(typeof fn.__sigxFn).toBe('function');
        await expect(fn(2, 3)).resolves.toBe(5);
    });

    it('invokes through __sigxFn with an explicit context', async () => {
        // Silence the #412 unvalidated-wire-args warning — a wire-shaped
        // invoke on a direct-form fn is exactly what it fires on.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn(async (rq, x: number) => {
            rq.status(201);
            return x * 2;
        });
        const ctx = createRequestContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        await expect(fn.__sigxFn(ctx, { symbol: 's', name: 'fn' }, [21])).resolves.toBe(42);
        expect(ctx._status).toBe(201);
    });
});

describe('serverFn — direct-form unvalidated wire args (#412)', () => {
    const wireCtx = () =>
        createRequestContext(new Request('http://localhost/_sigx/fn/x', { method: 'POST' }));
    const wireInfo = { symbol: 'quote_fn_12345678', name: 'quote' };

    it('warns once, naming the fn and pointing at the options form', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn(async (_rq, id: string) => id);
        await fn.__sigxFn(wireCtx(), wireInfo, ['a']);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"quote"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('input: Schema'));
        // Once per fn: a second wire call stays silent.
        await fn.__sigxFn(wireCtx(), wireInfo, ['b']);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('does not warn for a zero-arg wire call — no attacker-controlled input', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn(async () => 'static');
        await fn.__sigxFn(wireCtx(), wireInfo, []);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn for in-process calls (empty symbol) — authored code, not the wire', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn(async (_rq, id: string) => id);
        await expect(fn('a')).resolves.toBe('a');
        expect(warn).not.toHaveBeenCalled();
    });

    it('never fires for the options form — with or without input', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validated = serverFn({ input: schema, handler: async (_rq, i) => i.id });
        const unvalidated = serverFn({ handler: async (_rq, i: string) => i });
        await validated.__sigxFn(wireCtx(), wireInfo, [{ id: 'a' }]);
        await unvalidated.__sigxFn(wireCtx(), wireInfo, ['a']);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const fn = serverFn(async (_rq, id: string) => id);
            await fn.__sigxFn(wireCtx(), wireInfo, ['a']);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('serverFn — options form', () => {
    it('validates input before the handler and normalizes the value', async () => {
        const handler = vi.fn(async (_rq: unknown, input: { id: string }) => input.id);
        const fn = serverFn({ input: schema, handler });
        await expect(fn({ id: 'a', extra: 1 } as never)).resolves.toBe('a');
        // The handler received the VALIDATED value, not the raw input.
        expect(handler.mock.calls[0][1]).toEqual({ id: 'a' });
    });

    it('rejects invalid input with a branded 400 carrying the issues', async () => {
        const fn = serverFn({ input: schema, handler: async () => 'never' });
        const error = await fn({} as never).catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(400);
        expect((error as ServerFnError).data).toEqual({
            issues: [{ message: 'id must be a string' }]
        });
    });

    it('runs use guards before validation, in order, on every transport', async () => {
        const order: string[] = [];
        const fn = serverFn({
            use: [
                async (rq) => {
                    order.push('auth');
                    rq.locals.user = 'u1';
                },
                async () => {
                    order.push('rate');
                }
            ],
            input: schema,
            handler: async (rq, input) => `${rq.locals.user}:${input.id}`
        });
        const ctx = createRequestContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        await expect(fn.__sigxFn(ctx, { symbol: '', name: '' }, [{ id: 'a' }])).resolves.toBe('u1:a');
        expect(order).toEqual(['auth', 'rate']);
    });

    it('rejects extra wire arguments (single-input signature)', async () => {
        const fn = serverFn({ input: schema, handler: async (_rq, input) => input.id });
        const ctx = createRequestContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        const error = await fn
            .__sigxFn(ctx, { symbol: '', name: '' }, [{ id: 'a' }, 'smuggled'])
            .catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(400);
    });

    it('a throwing guard vetoes the call', async () => {
        const fn = serverFn({
            use: [
                async () => {
                    throw new ServerFnError(401, 'sign in first');
                }
            ],
            handler: async () => 'never'
        });
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
    });
});

describe('serverFn — live-client guard (rfc-server rev 2, N.2)', () => {
    const setMarker = (value: unknown) => {
        (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__ = value;
    };
    afterEach(() => {
        delete (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;
    });

    it('throws when invoked in a declared live client — server bodies never run there', () => {
        const fn = serverFn(async function leaked() {
            return 'server secret';
        });
        setMarker(true);
        expect(() => fn()).toThrow(/"leaked" reached a live client unextracted/);
        expect(() => fn()).toThrow(/role: 'client'/);
    });

    it('only the strict `true` marker trips it — absent or `false` runs normally', async () => {
        const fn = serverFn(async () => 'ok');
        await expect(fn()).resolves.toBe('ok');           // no marker
        setMarker(false);                                  // declared NOT a live client
        await expect(fn()).resolves.toBe('ok');
        setMarker('yes');                                  // sloppy truthy ≠ declared
        await expect(fn()).resolves.toBe('ok');
    });
});

describe('serverFn — detached (in-process) context', () => {
    it('rq.request throws a descriptive error', async () => {
        const fn = serverFn(async (rq) => rq.request.url);
        await expect(fn()).rejects.toThrow(/in-process server-function call/);
    });

    it('rq.locals and rq.abortSignal work without a request', async () => {
        const fn = serverFn(async (rq) => {
            rq.locals.x = 1;
            return rq.abortSignal.aborted;
        });
        await expect(fn()).resolves.toBe(false);
    });
});

describe('serverFn — .with({ signal }) per-call options (#353)', () => {
    it('the provided signal becomes rq.abortSignal on an in-process call', async () => {
        const fn = serverFn(async (rq) => rq.abortSignal);
        const controller = new AbortController();
        await expect(fn.with({ signal: controller.signal })()).resolves.toBe(controller.signal);
    });

    it('an aborted per-call signal is observable by the handler', async () => {
        const fn = serverFn(async (rq) => rq.abortSignal.aborted);
        const controller = new AbortController();
        controller.abort();
        await expect(fn.with({ signal: controller.signal })()).resolves.toBe(true);
    });

    it('the optionless call keeps the never-aborting detached default', async () => {
        const fn = serverFn(async (rq) => rq.abortSignal.aborted);
        await expect(fn()).resolves.toBe(false);
        await expect(fn.with()()).resolves.toBe(false);
    });

    it('the options-form pipeline (validation) still runs under .with()', async () => {
        const fn = serverFn({
            input: {
                '~standard': {
                    version: 1 as const,
                    vendor: 'test',
                    validate: (value: unknown) =>
                        typeof value === 'number'
                            ? { value }
                            : { issues: [{ message: 'not a number' }] }
                }
            },
            handler: async (_rq, input: number) => input * 2
        });
        const controller = new AbortController();
        await expect(fn.with({ signal: controller.signal })(21)).resolves.toBe(42);
        await expect(fn.with({ signal: controller.signal })('nope' as never)).rejects.toThrow(
            /Invalid input/
        );
    });

    it('transport-only options (headers/fresh) are warned no-ops in-process (#315)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn(async () => 'ran');
        await expect(fn.with({ headers: { 'x-trace-id': 't1' } })()).resolves.toBe('ran');
        await expect(fn.with({ fresh: true })()).resolves.toBe('ran');
        const ignored = warn.mock.calls.filter(([msg]) =>
            String(msg).includes('ignored on an in-process')
        );
        expect(ignored).toHaveLength(2);
        warn.mockRestore();
    });
});

describe('serverFn — options form with an input-less handler (#451)', () => {
    it('is callable with zero arguments', async () => {
        let hits = 0;
        const bump = serverFn({
            handler: async () => {
                hits += 1;
                return hits;
            }
        });
        // The compile-level point of #451: no argument required. Before the
        // `S = void` default, an input-less handler inferred S = `unknown`
        // and this call was "Expected 1 arguments, but got 0".
        await expect(bump()).resolves.toBe(1);
        // @ts-expect-error — zero-arg fn takes no input
        await expect(bump(1)).resolves.toBe(2);
    });

    it('still infers the input type when a schema is declared', async () => {
        const fn = serverFn({
            input: schema,
            handler: async (_rq, input) => input.id.toUpperCase()
        });
        await expect(fn({ id: 'ab' })).resolves.toBe('AB');
        // @ts-expect-error — schema-typed input, not zero-arg
        const bad: () => Promise<string> = fn;
        void bad;
    });

    it('a two-param handler without a schema still resolves to the one-arg form', () => {
        const fn = serverFn({
            handler: async (_rq, n: number) => n * 2
        });
        // Not the zero-arg overload: the declared input survives.
        const checked: (n: number) => Promise<number> = fn;
        void checked;
        // @ts-expect-error — input is required
        const bad: () => Promise<number> = fn;
        void bad;
    });
});
