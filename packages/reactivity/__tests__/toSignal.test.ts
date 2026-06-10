import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { signal, effect, watch, toSignal, toSignals, type PropertySignal } from '../src/index';

describe('toSignal', () => {
    it('reads through to the source', () => {
        const state = signal({ count: 1 });
        const count = toSignal(state, 'count');

        expect(count.value).toBe(1);

        state.count = 5;
        expect(count.value).toBe(5);
    });

    it('writes through to the source', () => {
        const state = signal({ count: 0 });
        const count = toSignal(state, 'count');

        count.value = 7;
        expect(state.count).toBe(7);
    });

    it('reads are tracked by effects', () => {
        const state = signal({ count: 0 });
        const count = toSignal(state, 'count');
        const fn = vi.fn();

        const runner = effect(() => {
            fn(count.value);
        });

        state.count = 1;
        expect(fn).toHaveBeenCalledWith(1);
        expect(fn).toHaveBeenCalledTimes(2);

        runner.stop();
    });

    it('writes trigger watchers on the source', () => {
        const state = signal({ count: 0 });
        const count = toSignal(state, 'count');
        const fn = vi.fn();

        const handle = watch(() => state.count, (value, prev) => {
            fn(value, prev);
        });

        count.value = 3;
        expect(fn).toHaveBeenCalledWith(3, 0);

        handle.stop();
    });

    it('supports functional updates via read-modify-write', () => {
        const state = signal({ count: 10 });
        const count = toSignal(state, 'count');

        count.value = count.value + 1;
        expect(state.count).toBe(11);
    });
});

describe('toSignals', () => {
    it('creates a view per own enumerable key', () => {
        const state = signal({ count: 0, name: 'Ada' });
        const signals = toSignals(state);

        expect(Object.keys(signals).sort()).toEqual(['count', 'name']);
        expect(signals.count.value).toBe(0);
        expect(signals.name.value).toBe('Ada');
    });

    it('destructured views stay reactive', () => {
        const state = signal({ count: 0, name: 'Ada' });
        const { count, name } = toSignals(state);
        const fn = vi.fn();

        const runner = effect(() => {
            fn(count.value, name.value);
        });

        state.count = 2;
        expect(fn).toHaveBeenCalledWith(2, 'Ada');

        name.value = 'Eve';
        expect(state.name).toBe('Eve');
        expect(fn).toHaveBeenCalledWith(2, 'Eve');

        runner.stop();
    });

    it('object-valued keys read the same proxy reference', () => {
        const inner = { nested: 1 };
        const state = signal({ obj: inner });
        const { obj } = toSignals(state);

        expect(obj.value).toBe(state.obj);

        obj.value.nested = 2;
        expect(state.obj.nested).toBe(2);
    });
});

describe('types', () => {
    it('preserves exact property types without widening', () => {
        const state = signal({ count: 0, status: 'idle' as 'idle' | 'busy' });

        const count = toSignal(state, 'count');
        expectTypeOf(count).toEqualTypeOf<PropertySignal<number>>();
        expectTypeOf(count.value).toEqualTypeOf<number>();

        const status = toSignal(state, 'status');
        expectTypeOf(status.value).toEqualTypeOf<'idle' | 'busy'>();

        const signals = toSignals(state);
        expectTypeOf(signals.count.value).toEqualTypeOf<number>();
        expectTypeOf(signals.status.value).toEqualTypeOf<'idle' | 'busy'>();
    });
});
