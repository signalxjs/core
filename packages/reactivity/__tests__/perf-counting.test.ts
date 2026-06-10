import { describe, it, expect, vi } from 'vitest';
import { signal, computed, effect, batch, watch } from '../src/index';

/**
 * Deterministic propagation-count proofs.
 *
 * Each test asserts the EXACT number of getter recomputations / effect runs
 * for a propagation scenario. These are the regression locks for the update
 * propagation work (#59): optimization stages tighten the asserted counts in
 * the same commit that improves the behavior, so any later regression fails
 * `pnpm test`. Assertions marked `STAGE n` are expected to be tightened by
 * that stage.
 */
describe('propagation counts', () => {
    describe('signals', () => {
        it('same-value write does not run effects', () => {
            const s = signal({ count: 2 });
            const runs = vi.fn();
            effect(() => { runs(s.count); });
            expect(runs).toHaveBeenCalledTimes(1);

            s.count = 2;
            expect(runs).toHaveBeenCalledTimes(1);
        });

        it('batched writes to 3 signals run a shared effect exactly once more', () => {
            const a = signal({ v: 0 });
            const b = signal({ v: 0 });
            const c = signal({ v: 0 });
            const runs = vi.fn();
            effect(() => { runs(a.v + b.v + c.v); });
            expect(runs).toHaveBeenCalledTimes(1);

            batch(() => {
                a.v = 1;
                b.v = 2;
                c.v = 3;
            });
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('1 signal fanned out to 100 effects: one batched write runs each exactly once more', () => {
            const s = signal({ v: 0 });
            const spies = Array.from({ length: 100 }, () => vi.fn());
            for (const spy of spies) {
                effect(() => { spy(s.v); });
            }

            batch(() => { s.v = 1; });

            for (const spy of spies) {
                expect(spy).toHaveBeenCalledTimes(2);
            }
        });
    });

    describe('computed', () => {
        it('deep chain (depth 50) stays lazy: writes never run unread getters', () => {
            const s = signal({ v: 0 });
            const getterSpies: Array<ReturnType<typeof vi.fn>> = [];
            let prev = computed(() => s.v);
            for (let i = 0; i < 50; i++) {
                const source = prev;
                const spy = vi.fn(() => source.value + 1);
                getterSpies.push(spy);
                prev = computed(spy);
            }
            const tail = prev;

            // Writes without any read must not compute anything.
            s.v = 1;
            s.v = 2;
            for (const spy of getterSpies) {
                expect(spy).toHaveBeenCalledTimes(0);
            }

            // A single read computes each layer exactly once.
            expect(tail.value).toBe(52);
            for (const spy of getterSpies) {
                expect(spy).toHaveBeenCalledTimes(1);
            }

            // A second read is fully cached.
            void tail.value;
            for (const spy of getterSpies) {
                expect(spy).toHaveBeenCalledTimes(1);
            }
        });

        it('value-equality cutoff: computed whose value is unchanged does not re-run effects', () => {
            const s = signal({ count: 2 });
            const getter = vi.fn(() => s.count > 0);
            const isPositive = computed(getter);
            const runs = vi.fn();
            effect(() => { runs(isPositive.value); });
            expect(runs).toHaveBeenCalledTimes(1);
            expect(getter).toHaveBeenCalledTimes(1);

            // 2 -> 5: still positive. The getter must re-validate, but the
            // effect must not observe a change (value-equality cutoff).
            s.count = 5;
            expect(getter).toHaveBeenCalledTimes(2);
            expect(runs).toHaveBeenCalledTimes(1);
        });

        it('diamond: one write runs the joint effect a bounded number of times', () => {
            const s = signal({ n: 0 });
            const c1Getter = vi.fn(() => s.n + 1);
            const c2Getter = vi.fn(() => s.n + 2);
            const c1 = computed(c1Getter);
            const c2 = computed(c2Getter);

            const observedPairs: Array<[number, number]> = [];
            const runs = vi.fn(() => {
                observedPairs.push([c1.value, c2.value]);
            });
            effect(runs);
            expect(runs).toHaveBeenCalledTimes(1);
            expect(observedPairs).toEqual([[1, 2]]);

            s.n = 10;

            // Single, glitch-free run per write: the mark phase flags both
            // branches before the effect executes, so no stale pair is ever
            // observable.
            expect(runs).toHaveBeenCalledTimes(2);
            expect(observedPairs).toEqual([[1, 2], [11, 12]]);

            // Each getter recomputes exactly once per write regardless.
            expect(c1Getter).toHaveBeenCalledTimes(2);
            expect(c2Getter).toHaveBeenCalledTimes(2);
        });

        it('chained cutoff: stable intermediate value stops downstream recomputation', () => {
            const s = signal({ n: 1 });
            const parityGetter = vi.fn(() => s.n % 2);
            const parity = computed(parityGetter);
            const labelGetter = vi.fn(() => (parity.value === 0 ? 'even' : 'odd'));
            const label = computed(labelGetter);
            const runs = vi.fn();
            effect(() => { runs(label.value); });
            expect(runs).toHaveBeenCalledTimes(1);

            // 1 -> 3: parity unchanged (1) — the cutoff stops at parity:
            // neither the downstream getter nor the effect runs again.
            s.n = 3;
            expect(parityGetter).toHaveBeenCalledTimes(2);
            expect(labelGetter).toHaveBeenCalledTimes(1);
            expect(runs).toHaveBeenCalledTimes(1);
        });
    });

    describe('push-pull edge cases', () => {
        it('effect on a signal AND a value-stable computed still runs for the signal change', () => {
            const s = signal({ count: 2, other: 0 });
            const isPositive = computed(() => s.count > 0);
            const runs = vi.fn();
            effect(() => { runs(s.other, isPositive.value); });
            expect(runs).toHaveBeenCalledTimes(1);

            s.other = 1; // direct signal dep: DIRTY, no validation needed
            expect(runs).toHaveBeenCalledTimes(2);

            s.count = 5; // only the computed dep, and its value is stable
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('throwing getter surfaces at read time and retries on next read', () => {
            const s = signal({ fail: true, v: 1 });
            const c = computed(() => {
                if (s.fail) throw new Error('boom');
                return s.v;
            });

            expect(() => c.value).toThrow('boom');
            // still subscribed: fixing the source makes the next read work
            s.fail = false;
            expect(c.value).toBe(1);
        });

        it('self-reading computed yields its cached value instead of overflowing the stack', () => {
            const s = signal({ v: 1 });
            const c: { value: number } = computed((): number => s.v + (c ? (c.value ?? 0) : 0));
            expect(() => c.value).not.toThrow();
        });

        it('watch on a value-stable computed source does not fire the callback', () => {
            const s = signal({ count: 2 });
            const isPositive = computed(() => s.count > 0);
            const cb = vi.fn();
            watch(() => isPositive.value, cb);

            s.count = 5;
            expect(cb).not.toHaveBeenCalled();

            s.count = -1;
            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(false, true, expect.anything());
        });

        it('cutoff works inside batch()', () => {
            const s = signal({ count: 2 });
            const isPositive = computed(() => s.count > 0);
            const runs = vi.fn();
            effect(() => { runs(isPositive.value); });

            batch(() => {
                s.count = 5;
                s.count = 9;
            });
            expect(runs).toHaveBeenCalledTimes(1);

            batch(() => {
                s.count = -1;
            });
            expect(runs).toHaveBeenCalledTimes(2);
        });
    });

    describe('collections and arrays', () => {
        it('Map.set runs an effect reading size + has() exactly once', () => {
            const m = signal(new Map<string, number>());
            const runs = vi.fn();
            effect(() => { runs(m.size, m.has('k')); });
            expect(runs).toHaveBeenCalledTimes(1);

            m.set('k', 1);
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('Map.delete runs an effect reading size + has() exactly once', () => {
            const m = signal(new Map<string, number>([['k', 1]]));
            const runs = vi.fn();
            effect(() => { runs(m.size, m.has('k')); });
            expect(runs).toHaveBeenCalledTimes(1);

            m.delete('k');
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('Set.clear runs an effect reading size + has() exactly once', () => {
            const s = signal(new Set<string>(['a', 'b']));
            const runs = vi.fn();
            effect(() => { runs(s.size, s.has('a')); });
            expect(runs).toHaveBeenCalledTimes(1);

            s.clear();
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('growing array index write runs an effect reading that index + length exactly once', () => {
            const arr = signal<(string | undefined)[]>(['a', 'b', 'c']);
            const runs = vi.fn();
            effect(() => { runs(arr[5], arr.length); });
            expect(runs).toHaveBeenCalledTimes(1);

            arr[5] = 'x'; // grows length 3 -> 6: index dep + length dep
            expect(runs).toHaveBeenCalledTimes(2);
        });

        it('array push runs an effect reading the array exactly once (already batched)', () => {
            const arr = signal<number[]>([1, 2]);
            const runs = vi.fn();
            effect(() => { runs(arr.length, arr[0]); });
            expect(runs).toHaveBeenCalledTimes(1);

            arr.push(3);
            expect(runs).toHaveBeenCalledTimes(2);
        });
    });
});
