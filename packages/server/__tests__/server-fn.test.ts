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
        const error = await fn(undefined as never).catch((e: unknown) => e);
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
