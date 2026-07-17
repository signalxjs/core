/**
 * @vitest-environment node
 *
 * serverFn() — the wrapper pipeline (rfc-server §2): direct and options
 * forms, `use` guards, `input` validation, and the detached in-process
 * context.
 */

import { describe, it, expect, vi } from 'vitest';
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
