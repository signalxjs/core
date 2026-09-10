/**
 * COMPILE-TIME pins for the single authoring form (rfc-server-v5 §1.1/§1.2):
 * the root tsconfig includes `__tests__`, so `pnpm typecheck` enforces every
 * `_pin` body below. The one runtime assertion per case only keeps vitest
 * from reporting an empty file. What is pinned:
 *
 * 1. `S` infers from the `input` schema; the callable takes `(input)`.
 * 2. No schema: `S` infers from the handler's destructured annotation.
 * 3. Neither: `S` is `void` and the callable takes ZERO arguments (#451/#454).
 * 4. Method shorthand `async handler({ input })` infers the same way.
 * 5. `invalidates` written AFTER `handler` sees a typed `result`.
 * 6. A stream with `input` yields a `(input) => AsyncIterable<T>` callable.
 * 7. `ServerPolicyOp` has no `args`; a policy reads `op.input`.
 * 8. The handler receives exactly `{ input, rq }` — no third positional.
 */
import { describe, it, expect } from 'vitest';
import {
    serverFn,
    serverStream,
    type ServerFnContext,
    type ServerFnHandlerArgs,
    type ServerPolicyOp,
    type StandardSchemaV1
} from '../src/index';

/** A no-op Standard Schema carrying only its output type. */
function schemaOf<T>(): StandardSchemaV1<T> {
    return {
        '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value) => ({ value: value as T })
        }
    };
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => {};

describe('serverFn — the single options form (compile-time pins)', () => {
    it('1. S infers from the input schema', () => {
        const _pin = (): void => {
            const fn = serverFn({
                input: schemaOf<{ id: string }>(),
                handler: async ({ input, rq }) => {
                    assertType<Equal<typeof input, { id: string }>>();
                    assertType<Equal<typeof rq, ServerFnContext>>();
                    return input.id.length;
                }
            });
            assertType<Equal<Parameters<typeof fn>, [{ id: string }]>>();
            assertType<Equal<Awaited<ReturnType<typeof fn>>, number>>();
            // @ts-expect-error — one input, not two.
            void fn({ id: 'a' }, 2);
        };
        expect(typeof _pin).toBe('function');
    });

    it('2. no schema: S infers from the destructured annotation', () => {
        const _pin = (): void => {
            const twice = serverFn({
                handler: async ({ input }: { input: number }) => input * 2
            });
            assertType<Equal<Parameters<typeof twice>, [number]>>();
            const both = serverFn({
                handler: async ({ input, rq }: ServerFnHandlerArgs<string>) => `${input}@${rq.url.pathname}`
            });
            assertType<Equal<Parameters<typeof both>, [string]>>();
            // @ts-expect-error — a number is not a string.
            void both(1);
        };
        expect(typeof _pin).toBe('function');
    });

    it('3. neither: S is void and the callable takes zero arguments (#451/#454)', () => {
        const _pin = (): void => {
            const vote = serverFn({ handler: async ({ rq }) => rq.url.pathname });
            assertType<Equal<Parameters<typeof vote>, []>>();
            void vote();
            // @ts-expect-error — an input-less function takes no argument.
            void vote(1);
            const bare = serverFn({ handler: async () => 1 });
            assertType<Equal<Parameters<typeof bare>, []>>();
        };
        expect(typeof _pin).toBe('function');
    });

    it('4. method shorthand infers the same way', () => {
        const _pin = (): void => {
            const fn = serverFn({
                input: schemaOf<{ n: number }>(),
                async handler({ input }) {
                    return input.n + 1;
                }
            });
            assertType<Equal<Parameters<typeof fn>, [{ n: number }]>>();
            assertType<Equal<Awaited<ReturnType<typeof fn>>, number>>();
        };
        expect(typeof _pin).toBe('function');
    });

    it('5. invalidates after handler sees a typed result', () => {
        const _pin = (): void => {
            serverFn({
                input: schemaOf<{ id: string }>(),
                handler: async ({ input }) => ({ id: input.id, total: 1 }),
                invalidates: (input, result) => {
                    assertType<Equal<typeof input, { id: string }>>();
                    assertType<Equal<typeof result, { id: string; total: number }>>();
                    return [['cart', result.id]];
                }
            });
        };
        expect(typeof _pin).toBe('function');
    });

    it('6. a stream with input is (input) => AsyncIterable<T>', () => {
        const _pin = (): void => {
            const ticks = serverStream({
                input: schemaOf<number>(),
                handler: async function* ({ input, rq }) {
                    assertType<Equal<typeof input, number>>();
                    assertType<Equal<typeof rq, ServerFnContext>>();
                    for (let i = 0; i < input; i++) yield String(i);
                }
            });
            assertType<Equal<Parameters<typeof ticks>, [number]>>();
            assertType<Equal<ReturnType<typeof ticks>, AsyncIterable<string>>>();
            const noInput = serverStream({
                handler: async function* () {
                    yield 1;
                }
            });
            assertType<Equal<Parameters<typeof noInput>, []>>();
        };
        expect(typeof _pin).toBe('function');
    });

    it('7. ServerPolicyOp has no args; a policy reads op.input', () => {
        const _pin = (op: ServerPolicyOp): void => {
            assertType<Equal<typeof op.input, unknown>>();
            // @ts-expect-error — the raw argument list is gone (rfc-server-v5 §1.1).
            void op.args;
        };
        expect(typeof _pin).toBe('function');
    });

    it('8. the handler receives exactly { input, rq }', () => {
        const _pin = (): void => {
            serverFn({
                input: schemaOf<string>(),
                // @ts-expect-error — one object parameter, never (rq, input).
                handler: async (_rq: ServerFnContext, _input: string) => 1
            });
            serverFn({
                handler: async (args) => {
                    assertType<Equal<keyof typeof args, 'input' | 'rq'>>();
                    return 1;
                }
            });
        };
        expect(typeof _pin).toBe('function');
    });
});
