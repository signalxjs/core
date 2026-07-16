import { describe, it, expect } from 'vitest';
import { signal, isSignal, computed, toSignal, toSignals } from '../src/index';

/**
 * Tests for isSignal (core#296) — recognizes signal-shaped `{ value }`
 * handles: primitive-wrapper signals and toSignal/toSignals property views.
 * Deliberately false for object signals (isReactive's job) and computeds
 * (isComputed's job), keeping the three predicates orthogonal.
 */
describe('isSignal', () => {
    it('recognizes primitive-wrapper signals', () => {
        expect(isSignal(signal(0))).toBe(true);
        expect(isSignal(signal('x'))).toBe(true);
        expect(isSignal(signal(false))).toBe(true);
        expect(isSignal(signal(null))).toBe(true);
        expect(isSignal(signal(undefined))).toBe(true);
    });

    it('recognizes toSignal / toSignals property views', () => {
        const state = signal({ count: 0, name: 'Ada' });

        expect(isSignal(toSignal(state, 'count'))).toBe(true);

        const { count, name } = toSignals(state);
        expect(isSignal(count)).toBe(true);
        expect(isSignal(name)).toBe(true);
    });

    it('is false for object signals and computeds', () => {
        expect(isSignal(signal({ x: 1 }))).toBe(false);
        expect(isSignal(signal([1, 2]))).toBe(false);
        expect(isSignal(computed(() => 1))).toBe(false);
    });

    it('is false for plain values and value-shaped plain objects', () => {
        expect(isSignal({ value: 1 })).toBe(false);
        expect(isSignal(signal({ value: 1 }))).toBe(false); // object signal, even value-shaped
        expect(isSignal(0)).toBe(false);
        expect(isSignal('value')).toBe(false);
        expect(isSignal(null)).toBe(false);
        expect(isSignal(undefined)).toBe(false);
        expect(isSignal(() => 1)).toBe(false);
    });

    it('still recognizes a primitive signal after writes', () => {
        const count = signal(0);
        count.value = 42;
        expect(isSignal(count)).toBe(true);
        expect(count.value).toBe(42);
    });
});
