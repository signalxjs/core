/**
 * @vitest-environment node
 *
 * serverFn() — the wrapper pipeline (rfc-server §2, order per
 * rfc-server-v4 §1.3, one authoring form since rfc-server-v5 §1.1):
 * the `{ input, rq }` handler contract, the frozen `__sigx` descriptor,
 * `authorize` policies, `input` validation, and the detached in-process
 * context. The app pipeline itself (middleware / authentication / the
 * identity gate / fail-closed misses) is pinned in app-pipeline.test.ts;
 * tests here run under a stubbed authenticated app so the pipeline is
 * transparent.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    serverFn,
    ServerFnError,
    isServerFnError,
    type ServerFnHandlerArgs,
    type ServerFnInfo,
    type StandardSchemaV1
} from '../src/index';
import { createRequestContext } from '../src/context';
import { createTestServerFnContext, stampServerFnKey, stubServerApp } from '../src/testing';

let restoreApp: () => void;
beforeEach(() => {
    restoreApp = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
});
afterEach(() => {
    restoreApp();
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

describe('serverFn — the wrapper and its descriptor (rfc-server-v5 §1.5)', () => {
    it('is a plain async function carrying the invoke pipeline on __sigx', async () => {
        const add = serverFn({
            handler: async ({ input: [a, b] }: { input: [number, number] }) => a + b
        });
        expect(typeof add.__sigx.invoke).toBe('function');
        await expect(add([2, 3])).resolves.toBe(5);
    });

    it('invokes through __sigx.invoke with an explicit context', async () => {
        // Silence the #437 unvalidated-wire-input warning — a wire-shaped
        // invoke on a schema-less fn is exactly what it fires on.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({
            handler: async ({ input: x, rq }: ServerFnHandlerArgs<number>) => {
                rq.status(201);
                return x * 2;
            }
        });
        const ctx = createRequestContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        await expect(
            fn.__sigx.invoke(ctx, { symbol: 's', name: 'fn', transport: 'wire' as const }, [21])
        ).resolves.toBe(42);
        expect(ctx._status).toBe(201);
    });

    it('the handler receives exactly { input, rq } — rq being the context handed to .with()', async () => {
        const seen: ServerFnHandlerArgs<number>[] = [];
        const fn = serverFn({
            handler: async (args: ServerFnHandlerArgs<number>) => {
                seen.push(args);
                return args.input;
            }
        });
        const locals = { trace: 't1' };
        const request = new Request('http://localhost/explicit');
        const ctx = createTestServerFnContext({ request, locals });
        await expect(fn.with({ context: ctx })(7)).resolves.toBe(7);
        expect(seen).toHaveLength(1);
        const [args] = seen;
        expect(Object.keys(args).sort()).toEqual(['input', 'rq']);
        expect(args.input).toBe(7);
        // The context is the one `.with({ context })` supplied: same request,
        // same locals store (the store-identity rule), same URL.
        expect(args.rq.request).toBe(request);
        expect(args.rq.locals).toBe(locals);
        expect(args.rq.url.pathname).toBe('/explicit');
    });

    it('__sigx is a frozen descriptor: kind "fn", boolean anon/form, read only when cache is declared', () => {
        const plain = serverFn({ handler: async () => 'ok' });
        expect(Object.isFrozen(plain.__sigx)).toBe(true);
        expect(plain.__sigx.kind).toBe('fn');
        expect(plain.__sigx.anon).toBe(false);
        expect(plain.__sigx.form).toBe(false);
        expect(plain.__sigx.read).toBeUndefined();
        expect(plain.__sigx.invalidates).toBeUndefined();
        expect(typeof plain.__sigx.invoke).toBe('function');
        // Frozen means a transport cannot be handed a partial shape later.
        expect(() => {
            (plain.__sigx as { form: boolean }).form = true;
        }).toThrow(TypeError);

        const read = serverFn({
            allowAnonymous: true,
            cache: { maxAge: 60, public: true },
            handler: async () => 'r'
        });
        expect(Object.isFrozen(read.__sigx)).toBe(true);
        expect(read.__sigx.anon).toBe(true);
        expect(read.__sigx.form).toBe(false);
        expect(read.__sigx.read).toEqual({ cacheControl: 'public, max-age=60, s-maxage=60' });
        expect(Object.isFrozen(read.__sigx.read)).toBe(true);

        const form = serverFn({ form: true, input: schema, handler: async ({ input }) => input.id });
        expect(form.__sigx.form).toBe(true);
        expect(form.__sigx.read).toBeUndefined();
    });

    it('in-process identity: middleware sees the stamped key as info.symbol and its last segment as info.name', async () => {
        const seen: ServerFnInfo[] = [];
        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (_rq, info) => {
                    seen.push(info);
                }
            ],
            authenticate: () => ({ id: 'u' })
        });
        const getCart = serverFn({ handler: async () => 'cart' });
        // Before the build stamps a key, the unstamped sentinel is what
        // middleware sees — `''`, the same value it always was.
        await expect(getCart()).resolves.toBe('cart');
        expect(seen).toEqual([{ symbol: '', name: '', transport: 'in-process' }]);
        seen.length = 0;
        // The key is read at CALL time, so a stamp AFTER definition (which is
        // when the Vite transform appends it) still reaches the pipeline.
        stampServerFnKey(getCart, 'app/cart.server.ts/getCart');
        await expect(getCart()).resolves.toBe('cart');
        expect(seen).toEqual([
            { symbol: 'app/cart.server.ts/getCart', name: 'getCart', transport: 'in-process' }
        ]);
    });
});

describe('serverFn — unvalidated wire input (#437)', () => {
    const wireCtx = () =>
        createRequestContext(new Request('http://localhost/_sigx/fn/x', { method: 'POST' }));
    const wireInfo = { symbol: 'save_fn_12345678', name: 'save', transport: 'wire' } as const;

    it('warns once when no `input` schema is declared, teaching `input`', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async ({ input: i }: { input: string }) => i });
        await fn.__sigx.invoke(wireCtx(), wireInfo, ['a']);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('serverFn "save"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('`input`'));
        // Once per fn: a second wire call stays silent.
        await fn.__sigx.invoke(wireCtx(), wireInfo, ['b']);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('does not warn for a zero-arg wire call — no attacker-controlled input', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async () => 'static' });
        await fn.__sigx.invoke(wireCtx(), wireInfo, []);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn for in-process calls — authored code, not the wire', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async ({ input: i }: { input: string }) => i });
        await expect(fn('a')).resolves.toBe('a');
        expect(warn).not.toHaveBeenCalled();
    });

    it('never fires for a fn with a declared `input` schema', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const validated = serverFn({ input: schema, handler: async ({ input }) => input.id });
        await validated.__sigx.invoke(wireCtx(), wireInfo, [{ id: 'a' }]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const fn = serverFn({ handler: async ({ input: i }: { input: string }) => i });
            await fn.__sigx.invoke(wireCtx(), wireInfo, ['a']);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('serverFn — validation and authorization', () => {
    it('validates input before the handler and normalizes the value', async () => {
        const handler = vi.fn(async ({ input }: ServerFnHandlerArgs<{ id: string }>) => input.id);
        const fn = serverFn({ input: schema, handler });
        await expect(fn({ id: 'a', extra: 1 } as never)).resolves.toBe('a');
        // The handler received the VALIDATED value, not the raw input.
        expect(handler.mock.calls[0][0].input).toEqual({ id: 'a' });
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

    it('runs authorize policies AFTER validation, in order, with the validated input (rfc-server-v4 §1.3)', async () => {
        const order: string[] = [];
        const seen: unknown[] = [];
        const fn = serverFn({
            authorize: [
                (principal, _rq, op) => {
                    order.push('policy-a');
                    seen.push(principal, op.input);
                    return true;
                },
                () => {
                    order.push('policy-b');
                    return true;
                }
            ],
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate(value) {
                        order.push('validate');
                        return { value: { id: (value as { id: string }).id } };
                    }
                }
            } satisfies StandardSchemaV1<{ id: string }>,
            handler: async ({ input }) => {
                order.push('handler');
                return input.id;
            }
        });
        await expect(fn({ id: 'a' })).resolves.toBe('a');
        expect(order).toEqual(['validate', 'policy-a', 'policy-b', 'handler']);
        // The policy saw the non-null principal and the VALIDATED input.
        expect(seen).toEqual([{ id: 'tester' }, { id: 'a' }]);
    });

    it('rejects extra wire arguments (single-input signature) — before validation', async () => {
        const validate = vi.fn((value: unknown) => ({ value: value as { id: string } }));
        const fn = serverFn({
            input: { '~standard': { version: 1, vendor: 'test', validate } },
            handler: async ({ input }) => input.id
        });
        const ctx = createRequestContext(
            new Request('http://localhost/_sigx/fn/x', { method: 'POST' })
        );
        const error = await fn.__sigx
            .invoke(ctx, { symbol: '', name: '', transport: 'in-process' as const }, [{ id: 'a' }, 'smuggled'])
            .catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(400);
        expect((error as ServerFnError).message).toBe('server functions take a single input argument');
        expect(validate).not.toHaveBeenCalled();
    });

    it('a policy returning anything but the literal true denies with a masked 403 — strict, fail-closed', async () => {
        for (const result of [false, undefined, 1, 'yes']) {
            const fn = serverFn({
                authorize: () => result as boolean,
                handler: async () => 'never'
            });
            const error = await fn().catch((e: unknown) => e);
            expect(isServerFnError(error)).toBe(true);
            expect((error as ServerFnError).status).toBe(403);
            expect((error as ServerFnError).message).toBe('Forbidden');
        }
    });

    it('a throwing policy passes its ServerFnError through verbatim', async () => {
        const fn = serverFn({
            authorize: () => {
                throw new ServerFnError(451, 'unavailable for legal reasons');
            },
            handler: async () => 'never'
        });
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(451);
    });

    it('a declared authorize REPLACES the app default — most-specific-wins', async () => {
        const appDefault = vi.fn(() => true);
        restoreApp();
        restoreApp = stubServerApp({
            authenticate: () => ({ id: 'tester' }),
            authorize: appDefault
        });
        const own = vi.fn(() => true);
        const fn = serverFn({ authorize: own, handler: async () => 'ok' });
        await expect(fn()).resolves.toBe('ok');
        expect(own).toHaveBeenCalledOnce();
        expect(appDefault).not.toHaveBeenCalled();
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
        const fn = serverFn({ handler: async () => 'server secret' });
        setMarker(true);
        // Unstamped: no name to show, the message still points at the fix.
        expect(() => fn()).toThrow(/server function reached a live client unextracted/);
        expect(() => fn()).toThrow(/role: 'client'/);
        // Stamped: the key's export name is what the message names.
        stampServerFnKey(fn, 'test/leaked');
        expect(() => fn()).toThrow(/"leaked" reached a live client unextracted/);
    });

    it('only the strict `true` marker trips it — absent or `false` runs normally', async () => {
        const fn = serverFn({ handler: async () => 'ok' });
        await expect(fn()).resolves.toBe('ok');           // no marker
        setMarker(false);                                  // declared NOT a live client
        await expect(fn()).resolves.toBe('ok');
        setMarker('yes');                                  // sloppy truthy ≠ declared
        await expect(fn()).resolves.toBe('ok');
    });
});

describe('serverFn — detached (in-process) context', () => {
    it('rq.request throws a descriptive error', async () => {
        const fn = serverFn({ handler: async ({ rq }) => rq.request.url });
        await expect(fn()).rejects.toThrow(/in-process server-function call/);
    });

    it('rq.locals and rq.abortSignal work without a request', async () => {
        const fn = serverFn({
            handler: async ({ rq }) => {
                rq.locals.x = 1;
                return rq.abortSignal.aborted;
            }
        });
        await expect(fn()).resolves.toBe(false);
    });
});

describe('serverFn — .with({ signal }) per-call options (#353)', () => {
    it('the provided signal becomes rq.abortSignal on an in-process call', async () => {
        const fn = serverFn({ handler: async ({ rq }) => rq.abortSignal });
        const controller = new AbortController();
        await expect(fn.with({ signal: controller.signal })()).resolves.toBe(controller.signal);
    });

    it('an aborted per-call signal is observable by the handler', async () => {
        const fn = serverFn({ handler: async ({ rq }) => rq.abortSignal.aborted });
        const controller = new AbortController();
        controller.abort();
        await expect(fn.with({ signal: controller.signal })()).resolves.toBe(true);
    });

    it('the optionless call keeps the never-aborting detached default', async () => {
        const fn = serverFn({ handler: async ({ rq }) => rq.abortSignal.aborted });
        await expect(fn()).resolves.toBe(false);
        await expect(fn.with()()).resolves.toBe(false);
    });

    it('the pipeline (validation) still runs under .with()', async () => {
        const numberSchema: StandardSchemaV1<number> = {
            '~standard': {
                version: 1,
                vendor: 'test',
                validate: (value) =>
                    typeof value === 'number'
                        ? { value }
                        : { issues: [{ message: 'not a number' }] }
            }
        };
        const fn = serverFn({
            input: numberSchema,
            handler: async ({ input }) => input * 2
        });
        const controller = new AbortController();
        await expect(fn.with({ signal: controller.signal })(21)).resolves.toBe(42);
        await expect(fn.with({ signal: controller.signal })('nope' as never)).rejects.toThrow(
            /Invalid input/
        );
    });

    it('transport-only options (headers/fresh) are warned no-ops in-process (#315)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fn = serverFn({ handler: async () => 'ran' });
        await expect(fn.with({ headers: { 'x-trace-id': 't1' } })()).resolves.toBe('ran');
        await expect(fn.with({ fresh: true })()).resolves.toBe('ran');
        const ignored = warn.mock.calls.filter(([msg]) =>
            String(msg).includes('ignored on an in-process')
        );
        expect(ignored).toHaveLength(2);
        warn.mockRestore();
    });
});

describe('serverFn — the input-less handler (#451)', () => {
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
            handler: async ({ input }) => input.id.toUpperCase()
        });
        await expect(fn({ id: 'ab' })).resolves.toBe('AB');
        // @ts-expect-error — schema-typed input, not zero-arg
        const bad: () => Promise<string> = fn;
        void bad;
    });

    it('an annotated handler without a schema still resolves to the one-arg form', () => {
        const fn = serverFn({
            handler: async ({ input: n }: { input: number }) => n * 2
        });
        // Not the zero-arg shape: the annotated input survives.
        const checked: (n: number) => Promise<number> = fn;
        void checked;
        // @ts-expect-error — input is required
        const bad: () => Promise<number> = fn;
        void bad;
    });
});

describe('the app default policy (rfc-server-v4 §1.2)', () => {
    it('a fn declaring no `input` runs the app default with op.input === undefined', async () => {
        const appDefault = vi.fn(() => true);
        restoreApp();
        restoreApp = stubServerApp({
            authenticate: () => ({ id: 'tester' }),
            authorize: appDefault
        });
        const fn = serverFn({ handler: async () => 'ok' });
        await expect(fn()).resolves.toBe('ok');
        expect(appDefault).toHaveBeenCalledOnce();
        const [principal, , op] = appDefault.mock.calls[0] as unknown as [
            unknown,
            unknown,
            { input?: unknown; args?: unknown }
        ];
        expect(principal).toEqual({ id: 'tester' });
        expect(op.input).toBeUndefined();
        // The retired `op.args` never comes back.
        expect('args' in op).toBe(false);
    });
});

describe('allowAnonymous — the per-fn identity-gate waiver (rfc-server-v4 §1.2)', () => {
    it('waives the gate: the fn runs with NO app configured at all', async () => {
        restoreApp();               // nothing stamped — the zero-config demo app
        const open = serverFn({ allowAnonymous: true, handler: async () => 'ok' });
        await expect(open()).resolves.toBe('ok');
        restoreApp = () => {};
    });

    it('records __sigx.anon so a wire transport can gate before decoding', () => {
        const open = serverFn({ allowAnonymous: true, handler: async () => 'ok' });
        expect(open.__sigx.anon).toBe(true);
        const closed = serverFn({ handler: async () => 'ok' });
        expect(closed.__sigx.anon).toBe(false);
    });

    it('declared policies still run, receiving a NULL principal when anonymous', async () => {
        restoreApp();
        restoreApp = stubServerApp({ authenticate: () => null });
        const seen: unknown[] = [];
        const fn = serverFn({
            allowAnonymous: true,
            authorize: (principal) => {
                seen.push(principal);
                return true;
            },
            handler: async () => 'ok'
        });
        await expect(fn()).resolves.toBe('ok');
        expect(seen).toEqual([null]);
    });

    it('a denying policy on an anonymous call is a 401, not a 403', async () => {
        restoreApp();
        restoreApp = stubServerApp({ authenticate: () => null });
        const fn = serverFn({
            allowAnonymous: true,
            authorize: () => false,
            handler: async () => 'never'
        });
        const error = await fn().catch((e: unknown) => e);
        expect(isServerFnError(error)).toBe(true);
        expect((error as ServerFnError).status).toBe(401);
    });

    it('does NOT skip the app default by accident: a bare allowAnonymous fn skips policies entirely, deliberately', async () => {
        // The defaults would re-deny the anonymity the literal granted
        // (requireAuthenticated over a null principal), so a bare
        // allowAnonymous declaration means "no requirement" (§1.3's table).
        const appDefault = vi.fn(() => false);
        restoreApp();
        restoreApp = stubServerApp({ authenticate: () => null, authorize: appDefault });
        const fn = serverFn({ allowAnonymous: true, handler: async () => 'ok' });
        await expect(fn()).resolves.toBe('ok');
        expect(appDefault).not.toHaveBeenCalled();
    });

    it('warns at definition time on cache.public without allowAnonymous — the shared-cache coherence check', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serverFn({
            cache: { maxAge: 60, public: true },
            handler: async () => 'r'
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('`cache.public`'));
        warn.mockClear();
        serverFn({
            allowAnonymous: true,
            cache: { maxAge: 60, public: true },
            handler: async () => 'r'
        });
        expect(warn).not.toHaveBeenCalled();
    });
});
