/**
 * @vitest-environment node
 *
 * serverFn() — the wrapper pipeline (rfc-server §2): direct and options
 * forms, `use` guards, `input` validation, and the detached in-process
 * context.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    serverFn,
    serverFnPreset,
    serverStream,
    ServerFnError,
    isServerFnError,
    type StandardSchemaV1
} from '../src/index';
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

    it('never fires for a validated options-form fn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validated = serverFn({ input: schema, handler: async (_rq, i) => i.id });
        await validated.__sigxFn(wireCtx(), wireInfo, [{ id: 'a' }]);
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

describe('serverFn — options-form unvalidated wire input (#437)', () => {
    const wireCtx = () =>
        createRequestContext(new Request('http://localhost/_sigx/fn/x', { method: 'POST' }));
    const wireInfo = { symbol: 'save_fn_12345678', name: 'save' };

    it('warns once when no `input` schema is declared, teaching `input`', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async (_rq, i: string) => i });
        await fn.__sigxFn(wireCtx(), wireInfo, ['a']);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"save"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('`input`'));
        // Once per fn: a second wire call stays silent.
        await fn.__sigxFn(wireCtx(), wireInfo, ['b']);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('does not warn for a zero-arg wire call — no attacker-controlled input', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async (_rq, _i: undefined) => 'static' });
        await fn.__sigxFn(wireCtx(), wireInfo, []);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn for in-process calls (empty symbol) — authored code, not the wire', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async (_rq, i: string) => i });
        await expect(fn('a')).resolves.toBe('a');
        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const fn = serverFn({ handler: async (_rq, i: string) => i });
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

describe('serverFnPreset — shared per-module middleware (#398)', () => {
    const trace: string[] = [];
    const record =
        (label: string) =>
        (): void => {
            trace.push(label);
        };

    afterEach(() => {
        trace.length = 0;
    });

    it('runs its guards on the IN-PROCESS path — the seam the direct form never had', async () => {
        const authed = serverFnPreset({ use: [record('preset')] });
        const fn = authed(async (_rq, a: number, b: number) => a + b);
        // No transport, no endpoint: a plain call, which is what `useData`
        // does during SSR. Before #398 this ran nothing.
        await expect(fn(2, 3)).resolves.toBe(5);
        expect(trace).toEqual(['preset']);
    });

    it('a multi-arg direct-form preset fn survives a WIRE-shaped invoke (F-B)', async () => {
        // The regression the RFC calls out: routing the direct form through
        // the options-form pipeline would 400 here on `args.length > 1`.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const authed = serverFnPreset({ use: [record('preset')] });
        const fn = authed(async (_rq, sku: string, qty: number) => `${sku}x${qty}`);
        const ctx = createRequestContext(new Request('https://x.test/_sigx/fn/add_fn_1'));
        await expect(
            fn.__sigxFn(ctx, { symbol: 'add_fn_1', name: 'add' }, ['sku', 2])
        ).resolves.toBe('skux2');
        expect(trace).toEqual(['preset']);
        warn.mockRestore();
    });

    it('runs preset guards BEFORE the function’s own use chain, and both before validation', async () => {
        const authed = serverFnPreset({ use: [record('preset-a'), record('preset-b')] });
        const fn = authed({
            use: [record('own')],
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate(value) {
                        trace.push('validate');
                        return { value: value as { id: string } };
                    }
                }
            } satisfies StandardSchemaV1<{ id: string }>,
            handler: async (_rq, input) => {
                trace.push('handler');
                return input.id;
            }
        });
        await expect(fn({ id: 'a' })).resolves.toBe('a');
        expect(trace).toEqual(['preset-a', 'preset-b', 'own', 'validate', 'handler']);
    });

    it('a throwing preset guard vetoes both forms', async () => {
        const authed = serverFnPreset({
            use: [
                (): void => {
                    throw new ServerFnError(401, 'sign in');
                }
            ]
        });
        const direct = authed(async () => 'never');
        const options = authed({ handler: async () => 'never' });
        for (const fn of [direct, options]) {
            const error = await fn().catch((e: unknown) => e);
            expect(isServerFnError(error)).toBe(true);
            expect((error as ServerFnError).status).toBe(401);
        }
    });

    it('runs its guards through .with({ context }) and hands them the supplied request', async () => {
        let seen: string | undefined;
        const authed = serverFnPreset({
            use: [
                (rq): void => {
                    seen = rq.request.url;
                }
            ]
        });
        const fn = authed(async (rq) => rq.url.pathname);
        const request = new Request('https://x.test/board?tab=open');
        await expect(fn.with({ context: request })()).resolves.toBe('/board');
        expect(seen).toBe('https://x.test/board?tab=open');
    });

    it('copies the guard array once — a policy the app can mutate is not a policy', async () => {
        const guards = [record('initial')];
        const authed = serverFnPreset({ use: guards });
        const before = authed(async () => 'ok');
        guards.push(record('smuggled'));
        const after = authed(async () => 'ok');
        await before();
        await after();
        expect(trace).toEqual(['initial', 'initial']);
    });

    it('carries every definition-level mark through the derived options form', async () => {
        const authed = serverFnPreset({ use: [record('preset')] });
        const read = authed({ cache: { maxAge: 60 }, handler: async () => 'r' });
        expect(read.__sigxGet).toBe(true);
        expect(read.__sigxCacheControl).toBe('private, max-age=60');

        const mutation = authed({ handler: async () => 'm', invalidates: () => ['cart'] });
        expect(typeof mutation.__sigxInvalidates).toBe('function');

        const action = authed({ form: true, input: schema, handler: async () => 'a' });
        expect(action.__sigxForm).toBe(true);
    });

    it('still throws at definition time for `form` without `input` (#412)', () => {
        const authed = serverFnPreset({ use: [] });
        expect(() => authed({ form: true, handler: async () => 'x' })).toThrow(
            /declares `form` without `input`/
        );
    });

    it('types the derived callable exactly as serverFn does', () => {
        const authed = serverFnPreset({ use: [] });

        const two: (sku: string, qty: number) => Promise<string> = authed(
            async (_rq, sku: string, qty: number) => `${sku}${qty}`
        );
        void two;

        const zero: () => Promise<number> = authed({ handler: async () => 1 });
        void zero;

        const one: (input: { id: string }) => Promise<string> = authed({
            input: schema,
            handler: async (_rq, input) => input.id
        });
        void one;

        // @ts-expect-error — a declared input is required, exactly as on serverFn
        const bad: () => Promise<string> = one;
        void bad;

        const stream: typeof serverStream = authed.stream;
        void stream;
    });
});

describe('unguarded — the deliberate opt-out (#489)', () => {
    it('is runtime-inert on a plain function', async () => {
        const open = serverFn({ unguarded: true, handler: async () => 'ok' });
        await expect(open()).resolves.toBe('ok');
    });

    it('contradicting a preset throws at DEFINITION time, not per request', () => {
        const authed = serverFnPreset({ use: [() => {}] });
        // Not __DEV__-gated: a security declaration that is false must fail at
        // boot or in CI, where a dev-only warning would be silent.
        expect(() => authed({ unguarded: true, handler: async () => 1 })).toThrow(
            /declares `unguarded: true` but derives from a serverFnPreset/
        );
        expect(() =>
            authed.stream({ unguarded: true, handler: async function* () { yield 1; } })
        ).toThrow(/declares `unguarded: true` but derives from a serverFnPreset/);
    });

    it('a preset-derived function without the contradiction is unaffected', async () => {
        const authed = serverFnPreset({ use: [() => {}] });
        await expect(authed({ handler: async () => 'ok' })()).resolves.toBe('ok');
    });
});

describe('the unchecked-function warning (#489, §1.5)', () => {
    const CHECKED = '__SIGX_GUARDS_CHECKED__';
    const setBuildChecked = (value: boolean | undefined): void => {
        if (value === undefined) delete (globalThis as Record<string, unknown>)[CHECKED];
        else (globalThis as Record<string, unknown>)[CHECKED] = value;
    };

    afterEach(() => setBuildChecked(undefined));

    it('fires ONCE per function, not once per call', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setBuildChecked(true);
        const fn = serverFn({ unguarded: true, handler: async () => 'ok' });

        await fn();
        await fn();
        await fn();

        const notices = warn.mock.calls
            .map(([m]) => String(m))
            .filter((m) => m.includes('never analyzed by the guard check'));
        expect(notices).toHaveLength(1);
    });

    it('says nothing when the build stamped the function', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setBuildChecked(true);
        const fn = serverFn({ unguarded: true, handler: async () => 'ok' });
        // What the transform appends to the SSR module.
        (fn as unknown as { __sigxGuardChecked?: boolean }).__sigxGuardChecked = true;

        await fn();
        expect(
            warn.mock.calls.filter(([m]) => String(m).includes('never analyzed'))
        ).toHaveLength(0);
    });

    it('says nothing when NO build did the checking — absence is the alarm', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // No marker: a unit test or a hand-wired non-Vite build. Warning here
        // would mean "you are not using Vite", which is not a defect.
        setBuildChecked(undefined);
        const fn = serverFn({ unguarded: true, handler: async () => 'ok' });

        await fn();
        expect(
            warn.mock.calls.filter(([m]) => String(m).includes('never analyzed'))
        ).toHaveLength(0);
    });
});
