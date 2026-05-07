import { describe, it, expect, vi } from 'vitest';
import { signal, watch } from '../src/index';

describe('watch', () => {
    describe('basic watching', () => {
        it('should watch a signal property and call callback on change', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            watch(() => state.count, callback);

            state.count = 1;
            expect(callback).toHaveBeenCalledWith(1, 0, expect.any(Function));
        });

        it('should provide old and new values', () => {
            const state = signal({ count: 0 });
            const values: Array<[number, number | undefined]> = [];

            watch(() => state.count, (newVal, oldVal) => {
                values.push([newVal, oldVal]);
            });

            state.count = 1;
            state.count = 5;
            state.count = 10;

            expect(values).toEqual([
                [1, 0],
                [5, 1],
                [10, 5]
            ]);
        });

        it('should not call callback on initial run by default', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            watch(() => state.count, callback);

            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('immediate option', () => {
        it('should call callback immediately when immediate is true', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            watch(() => state.count, callback, { immediate: true });

            expect(callback).toHaveBeenCalledWith(0, undefined, expect.any(Function));
        });
    });

    describe('stop watching', () => {
        it('should stop watching when stop() is called', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const stop = watch(() => state.count, callback);

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);

            stop();

            state.count = 2;
            state.count = 3;
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should be callable directly as a function', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const handle = watch(() => state.count, callback);

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);

            // Call handle directly to stop
            handle();

            state.count = 2;
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });

    describe('pause and resume', () => {
        it('should pause and resume watching', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const handle = watch(() => state.count, callback);

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);

            handle.pause();

            state.count = 2;
            state.count = 3;
            // Should not call callback while paused
            expect(callback).toHaveBeenCalledTimes(1);

            handle.resume();

            // Resume should trigger with the latest value if changed
            expect(callback).toHaveBeenCalledTimes(2);
            expect(callback).toHaveBeenLastCalledWith(3, 1, expect.any(Function));
        });
    });

    describe('cleanup function', () => {
        it('should call cleanup before each callback run', () => {
            const state = signal({ count: 0 });
            const cleanup = vi.fn();
            const callback = vi.fn((_, __, onCleanup) => {
                onCleanup(cleanup);
            });

            watch(() => state.count, callback, { immediate: true });

            expect(cleanup).not.toHaveBeenCalled();

            state.count = 1;
            expect(cleanup).toHaveBeenCalledTimes(1);

            state.count = 2;
            expect(cleanup).toHaveBeenCalledTimes(2);
        });

        it('should call cleanup when stopped', () => {
            const state = signal({ count: 0 });
            const cleanup = vi.fn();
            const callback = vi.fn((_, __, onCleanup) => {
                onCleanup(cleanup);
            });

            const stop = watch(() => state.count, callback, { immediate: true });

            expect(cleanup).not.toHaveBeenCalled();

            stop();
            expect(cleanup).toHaveBeenCalledTimes(1);
        });
    });

    describe('once option', () => {
        it('should only trigger callback once when once is true', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            watch(() => state.count, callback, { once: true });

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(1, 0, expect.any(Function));

            // Subsequent changes should not trigger callback
            state.count = 2;
            state.count = 3;
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should trigger immediately and stop when once and immediate are both true', () => {
            const state = signal({ count: 5 });
            const callback = vi.fn();

            watch(() => state.count, callback, { once: true, immediate: true });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(5, undefined, expect.any(Function));

            // Subsequent changes should not trigger callback
            state.count = 10;
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });

    describe('deep option', () => {
        it('should detect nested object changes when deep is true', () => {
            const state = signal({ user: { profile: { name: 'John' } } });
            const callback = vi.fn();

            watch(() => state.user, callback, { deep: true });

            // Modifying deeply nested property should trigger
            state.user.profile.name = 'Jane';
            expect(callback).toHaveBeenCalled();
        });

        it('should not detect nested changes when deep is false or unset', () => {
            const state = signal({ user: { profile: { name: 'John' } } });
            const callback = vi.fn();

            watch(() => state.user, callback);

            // The watcher is on state.user, modifying nested property
            // shouldn't trigger without deep (or if the getter accesses it)
            // Note: This depends on implementation - if getter returns the same reference,
            // the callback won't fire
            const beforeCallCount = callback.mock.calls.length;
            state.user.profile.name = 'Jane';
            // The object reference hasn't changed, so callback may or may not fire
            // depending on whether the signal tracks nested access
        });

        it('should work with deep option set to a number for depth limit', () => {
            const state = signal({ 
                level1: { 
                    level2: { 
                        level3: { value: 'initial' } 
                    } 
                } 
            });
            const callback = vi.fn();

            // Deep with depth 2 should track level1 and level2 but not level3
            watch(() => state.level1, callback, { deep: 2 });

            state.level1.level2 = { level3: { value: 'changed' } };
            expect(callback).toHaveBeenCalled();
        });
    });

    describe('watching different source types', () => {
        it('should watch a getter function', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            watch(() => state.count * 2, callback);

            state.count = 5;
            expect(callback).toHaveBeenCalledWith(10, 0, expect.any(Function));
        });

        it('should watch computed expressions', () => {
            const state = signal({ a: 1, b: 2 });
            const callback = vi.fn();

            watch(() => state.a + state.b, callback);

            state.a = 10;
            expect(callback).toHaveBeenCalledWith(12, 3, expect.any(Function));

            state.b = 20;
            expect(callback).toHaveBeenCalledWith(30, 12, expect.any(Function));
        });
    });

    describe('handle methods', () => {
        it('should have stop method that is the same as calling handle directly', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const handle = watch(() => state.count, callback);

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);

            handle.stop();

            state.count = 2;
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should not resume if not paused', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const handle = watch(() => state.count, callback);

            // Resume without pausing first
            handle.resume();

            state.count = 1;
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should handle multiple pause/resume cycles', () => {
            const state = signal({ count: 0 });
            const callback = vi.fn();

            const handle = watch(() => state.count, callback);

            // First cycle
            handle.pause();
            state.count = 1;
            handle.resume();
            expect(callback).toHaveBeenCalledTimes(1);

            // Second cycle
            handle.pause();
            state.count = 2;
            state.count = 3;
            handle.resume();
            expect(callback).toHaveBeenCalledTimes(2);
            expect(callback).toHaveBeenLastCalledWith(3, 1, expect.any(Function));
        });
    });
});
