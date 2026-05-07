import { describe, it, expect, vi } from 'vitest';
import { signal, effect, batch } from '../src/index';

describe('effect', () => {
    describe('basic behavior', () => {
        it('should run immediately on creation', () => {
            const fn = vi.fn();
            effect(fn);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should re-run when tracked dependencies change', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledWith(0);
            state.count = 1;
            expect(fn).toHaveBeenCalledWith(1);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should track multiple dependencies', () => {
            const state = signal({ a: 1, b: 2 });
            let sum = 0;
            effect(() => {
                sum = state.a + state.b;
            });
            expect(sum).toBe(3);
            state.a = 10;
            expect(sum).toBe(12);
            state.b = 20;
            expect(sum).toBe(30);
        });

        it('should not trigger if value does not change', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            state.count = 0; // Same value
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should track nested object properties', () => {
            const state = signal({ user: { name: 'John' } });
            const fn = vi.fn();
            effect(() => {
                fn(state.user.name);
            });
            expect(fn).toHaveBeenCalledWith('John');
            state.user.name = 'Jane';
            expect(fn).toHaveBeenCalledWith('Jane');
        });
    });

    describe('EffectRunner', () => {
        it('should return an EffectRunner object', () => {
            const runner = effect(() => {});
            expect(typeof runner).toBe('function');
            expect(typeof runner.stop).toBe('function');
        });

        it('should stop tracking when stop() is called', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            const runner = effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            runner.stop();
            state.count = 5;
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should not re-execute after stop() even if already in trigger snapshot', () => {
            const state = signal({ count: 0 });
            const fnA = vi.fn();
            const fnB = vi.fn();
            let runnerB: ReturnType<typeof effect>;

            // Effect A subscribes first and stops B when triggered
            effect(() => {
                fnA(state.count);
                if (state.count > 0) {
                    runnerB.stop();
                }
            });
            expect(fnA).toHaveBeenCalledTimes(1);

            // Effect B subscribes second
            runnerB = effect(() => {
                fnB(state.count);
            });
            expect(fnB).toHaveBeenCalledTimes(1);

            // Trigger: both effects are in the snapshot.
            // A fires first (subscribed first) and stops B.
            // B is still in the snapshot but should NOT fire.
            state.count = 1;
            expect(fnA).toHaveBeenCalledTimes(2);
            expect(fnB).toHaveBeenCalledTimes(1); // B should not have fired again
        });

        it('should not re-subscribe after stop() via stale trigger execution', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();

            const runner = effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            // Stop the effect
            runner.stop();

            // Calling the stopped runner is a no-op (simulates stale snapshot)
            runner();
            expect(fn).toHaveBeenCalledTimes(1);

            // Signal change should NOT trigger the stopped effect
            state.count = 5;
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should not re-run when called manually after stop()', () => {
            const state = signal({ count: 0 });
            const fn = vi.fn();
            const runner = effect(() => {
                fn(state.count);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            runner.stop();
            // Manual call should be a no-op after stop
            runner();
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('array reactivity', () => {
        it('should track array index access', () => {
            const arr = signal([1, 2, 3]);
            let value: number = 0;
            effect(() => {
                value = arr[0];
            });
            expect(value).toBe(1);
            arr[0] = 10;
            expect(value).toBe(10);
        });

        it('should track array length', () => {
            const arr = signal([1, 2, 3]);
            let length = 0;
            effect(() => {
                length = arr.length;
            });
            expect(length).toBe(3);
            arr.push(4);
            expect(length).toBe(4);
        });

        it('should batch array mutating methods', () => {
            const arr = signal([1, 2, 3]);
            let runCount = 0;
            effect(() => {
                void arr.length;
                runCount++;
            });
            expect(runCount).toBe(1);
            arr.push(4, 5, 6);
            expect(runCount).toBe(2);
        });
    });

    describe('with batch', () => {
        it('should only run once after batch completes', () => {
            const state = signal({ a: 0, b: 0 });
            let runCount = 0;
            effect(() => {
                void state.a;
                void state.b;
                runCount++;
            });
            expect(runCount).toBe(1);

            batch(() => {
                state.a = 1;
                state.b = 2;
            });

            expect(runCount).toBe(2); // Initial + 1 batched
        });

        it('should run after nested batches complete', () => {
            const state = signal({ count: 0 });
            let runCount = 0;
            effect(() => {
                void state.count;
                runCount++;
            });
            expect(runCount).toBe(1);

            batch(() => {
                state.count = 1;
                batch(() => {
                    state.count = 2;
                });
                state.count = 3;
            });

            expect(runCount).toBe(2);
            expect(state.count).toBe(3);
        });
    });

    describe('dynamic dependency tracking', () => {
        it('should update dependencies on each run', () => {
            const state = signal({ a: 1, b: 2, useA: true });
            const fn = vi.fn();
            
            effect(() => {
                if (state.useA) {
                    fn('a', state.a);
                } else {
                    fn('b', state.b);
                }
            });
            
            expect(fn).toHaveBeenCalledWith('a', 1);
            
            // Changing b shouldn't trigger because we're using a
            state.b = 20;
            expect(fn).toHaveBeenCalledTimes(1);
            
            // Switch to using b
            state.useA = false;
            expect(fn).toHaveBeenCalledWith('b', 20);
            
            // Now changing a shouldn't trigger
            state.a = 100;
            expect(fn).toHaveBeenCalledTimes(2);
            
            // But changing b should
            state.b = 200;
            expect(fn).toHaveBeenCalledWith('b', 200);
        });
    });

    describe('nested effects', () => {
        it('should preserve currentSubscriber across nested effect triggers', () => {
            // When effect A writes to a signal during execution, triggering effect B,
            // A should still track signals read after B completes.
            const triggerA = signal({ value: false });
            const signalForB = signal({ value: 0 });
            const trackedAfterB = signal({ value: 'initial' });

            const innerFn = vi.fn();
            // Effect B: depends on 'signalForB'
            effect(() => {
                innerFn(signalForB.value);
            });
            expect(innerFn).toHaveBeenCalledTimes(1);

            let trackedValue = '';
            // Effect A: writes to signalForB (triggering B), then reads trackedAfterB
            effect(() => {
                void triggerA.value; // force re-run
                signalForB.value = Date.now(); // triggers B (pure write, no read)
                trackedValue = trackedAfterB.value; // should still be tracked
            });
            expect(trackedValue).toBe('initial');

            // Change trackedAfterB — effect A should re-run because it read trackedAfterB.value
            trackedAfterB.value = 'updated';
            expect(trackedValue).toBe('updated');
        });
    });
    describe('primitive signals', () => {
        it('should track primitive signal changes', () => {
            const count = signal(0);
            let effectValue = -1;
            effect(() => {
                effectValue = count.value;
            });
            expect(effectValue).toBe(0);
            count.value = 10;
            expect(effectValue).toBe(10);
        });

        it('should not trigger if primitive value does not change', () => {
            const count = signal(5);
            const fn = vi.fn();
            effect(() => {
                fn(count.value);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            count.value = 5; // Same value
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
});
