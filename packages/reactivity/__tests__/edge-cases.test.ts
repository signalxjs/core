import { describe, it, expect, vi } from 'vitest';
import { signal, effect, computed, batch, toRaw, isReactive } from '../src/index';
import { shouldNotProxy } from '../src/collections';

describe('Edge Cases', () => {
    describe('shouldNotProxy', () => {
        it('returns true for Date', () => {
            expect(shouldNotProxy(new Date())).toBe(true);
        });

        it('returns true for RegExp', () => {
            expect(shouldNotProxy(new RegExp(''))).toBe(true);
        });

        it('returns true for Error', () => {
            expect(shouldNotProxy(new Error())).toBe(true);
        });

        it('returns true for Promise', () => {
            expect(shouldNotProxy(Promise.resolve())).toBe(true);
        });

        it('returns true for ArrayBuffer', () => {
            expect(shouldNotProxy(new ArrayBuffer(8))).toBe(true);
        });

        it('returns true for Uint8Array', () => {
            expect(shouldNotProxy(new Uint8Array(8))).toBe(true);
        });

        it('returns false for plain object', () => {
            expect(shouldNotProxy({})).toBe(false);
        });

        it('returns false for array', () => {
            expect(shouldNotProxy([])).toBe(false);
        });

        it('returns false for null', () => {
            expect(shouldNotProxy(null)).toBe(false);
        });

        it('returns false for number', () => {
            expect(shouldNotProxy(42)).toBe(false);
        });
    });

    describe('signal with non-proxyable values', () => {
        it('stores nested Date as raw (not proxied)', () => {
            const date = new Date('2024-01-01');
            const state = signal({ date });
            expect(state.date).toBe(date);
            expect(isReactive(state.date)).toBe(false);
        });

        it('stores nested RegExp as raw (not proxied)', () => {
            const regex = /test/gi;
            const state = signal({ pattern: regex });
            expect(state.pattern).toBe(regex);
            expect(isReactive(state.pattern)).toBe(false);
        });
    });

    describe('deeply nested reactivity', () => {
        it('mutating a deep property triggers effect', () => {
            const state = signal({ a: { b: { c: 1 } } });
            const fn = vi.fn();
            effect(() => {
                fn(state.a.b.c);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenLastCalledWith(1);

            state.a.b.c = 42;
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(42);
        });

        it('replacing a nested object entirely triggers effect', () => {
            const state = signal({ nested: { value: 1 } });
            const fn = vi.fn();
            effect(() => {
                fn(state.nested.value);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenLastCalledWith(1);

            state.nested = { value: 99 };
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(99);
        });
    });

    describe('batch edge cases', () => {
        it('nested batch calls — effects fire only after outermost batch', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            batch(() => {
                state.count = 1;
                batch(() => {
                    state.count = 2;
                });
                // inner batch ended, but outer hasn't — effect should NOT have re-run yet
                expect(fn).toHaveBeenCalledTimes(1);
                state.count = 3;
            });

            // now outermost batch completed — effect fires once with final value
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(3);
        });

        it('batch with no mutations does not trigger effects', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            batch(() => {
                // no mutations
            });

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('batch with single mutation fires effect once after batch', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            batch(() => {
                state.count = 5;
            });

            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(5);
        });

        it('multiple mutations in batch fires effect once', () => {
            const state = signal({ a: 0, b: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.a + state.b);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            batch(() => {
                state.a = 10;
                state.b = 20;
            });

            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(30);
        });
    });

    describe('effect edge cases', () => {
        it('stop() prevents further tracking and re-runs', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            const runner = effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            runner.stop();
            state.count = 10;
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('reading the same signal property multiple times only triggers once per change', () => {
            const state = signal({ value: 0 });
            const fn = vi.fn();
            effect(() => {
                // read state.value three times
                fn(state.value + state.value + state.value);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenLastCalledWith(0);

            state.value = 5;
            // effect should fire exactly once, not three times
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(15);
        });

        it('conditional branch tracking — only active branch is tracked', () => {
            const state = signal({ toggle: true, a: 1, b: 2 });
            const fn = vi.fn();
            effect(() => {
                if (state.toggle) {
                    fn(state.a);
                } else {
                    fn(state.b);
                }
            });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenLastCalledWith(1);

            // change b — should NOT trigger since toggle is true (b is not tracked)
            state.b = 20;
            expect(fn).toHaveBeenCalledTimes(1);

            // flip the branch
            state.toggle = false;
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenLastCalledWith(20);

            // now a should no longer be tracked
            state.a = 100;
            expect(fn).toHaveBeenCalledTimes(2);

            // but b is now tracked
            state.b = 30;
            expect(fn).toHaveBeenCalledTimes(3);
            expect(fn).toHaveBeenLastCalledWith(30);
        });
    });

    describe('computed edge cases', () => {
        it('computed with throwing getter propagates the error', () => {
            const c = computed(() => {
                throw new Error('boom');
            });
            expect(() => c.value).toThrow('boom');
        });

        it('computed that depends on another computed (chain)', () => {
            const state = signal({ count: 2 });
            const doubled = computed(() => state.count * 2);
            const quadrupled = computed(() => doubled.value * 2);

            expect(quadrupled.value).toBe(8);

            state.count = 5;
            expect(doubled.value).toBe(10);
            expect(quadrupled.value).toBe(20);
        });

        it('computed is lazy — getter not called until .value accessed', () => {
            const getter = vi.fn(() => 42);
            const c = computed(getter);

            expect(getter).not.toHaveBeenCalled();

            expect(c.value).toBe(42);
            expect(getter).toHaveBeenCalledTimes(1);
        });
    });

    describe('toRaw and isReactive', () => {
        it('toRaw on non-reactive value returns the same value', () => {
            const plain = { a: 1 };
            expect(toRaw(plain)).toBe(plain);
        });

        it('toRaw on nested reactive property returns raw object', () => {
            const raw = { nested: { value: 1 } };
            const state = signal(raw);

            // state is reactive; toRaw unwraps it
            expect(toRaw(state)).toBe(raw);

            // accessing state.nested returns a reactive proxy; toRaw unwraps it
            const nestedProxy = state.nested;
            expect(isReactive(nestedProxy)).toBe(true);
            expect(toRaw(nestedProxy)).toBe(raw.nested);
        });

        it('isReactive on plain object returns false', () => {
            expect(isReactive({})).toBe(false);
            expect(isReactive({ a: 1 })).toBe(false);
        });

        it('isReactive on signal object returns true', () => {
            const state = signal({ count: 0 });
            expect(isReactive(state)).toBe(true);
        });
    });
});
