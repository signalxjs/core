/**
 * Shared model-modifier primitive: the pluggable registry, value-transform
 * application, timing resolution, write-back wrapping, and the built-ins.
 *
 * NOTE: the registry is module-global; vitest isolates modules per test file,
 * so registrations here cannot leak into other suites.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    registerModelModifier,
    getModelModifier,
    applyModelTransforms,
    resolveTiming,
    wrapModelWriteBack,
    getHandlerModifiers,
    createDebounceScheduler,
} from '../src/model-modifiers';

describe('built-in modifiers', () => {
    it('registers trim/number as transforms and lazy/debounce as timing', () => {
        expect(getModelModifier('trim')?.transform).toBeTypeOf('function');
        expect(getModelModifier('number')?.transform).toBeTypeOf('function');
        expect(getModelModifier('lazy')?.timing).toBe('lazy');
        expect(getModelModifier('debounce')?.timing).toBe('debounce');
    });

    it('trim strips whitespace only on strings', () => {
        expect(applyModelTransforms('  hi  ', { trim: true })).toBe('hi');
        expect(applyModelTransforms(42, { trim: true })).toBe(42);
        expect(applyModelTransforms(true, { trim: true })).toBe(true);
    });

    it('number coerces numeric strings, leaves the rest untouched', () => {
        expect(applyModelTransforms('42', { number: true })).toBe(42);
        expect(applyModelTransforms('abc', { number: true })).toBe('abc');
        expect(applyModelTransforms(['a'], { number: true })).toEqual(['a']);
    });
});

describe('applyModelTransforms', () => {
    it('applies transforms in authoring (key) order', () => {
        // trim → number: "  42 " → "42" → 42
        expect(applyModelTransforms('  42 ', { trim: true, number: true })).toBe(42);
    });

    it('skips falsy / nullish modifier options and timing-only modifiers', () => {
        expect(applyModelTransforms('  hi  ', { trim: false, lazy: true })).toBe('  hi  ');
        expect(applyModelTransforms('  hi  ', undefined)).toBe('  hi  ');
    });
});

describe('resolveTiming', () => {
    it('derives lazy and debounce ms from registered timing hints', () => {
        expect(resolveTiming({ lazy: true })).toEqual({ lazy: true, debounceMs: null });
        expect(resolveTiming({ debounce: 250 })).toEqual({ lazy: false, debounceMs: 250 });
        expect(resolveTiming({ debounce: true })).toEqual({ lazy: false, debounceMs: 300 });
        expect(resolveTiming({ trim: true })).toEqual({ lazy: false, debounceMs: null });
        expect(resolveTiming(undefined)).toEqual({ lazy: false, debounceMs: null });
    });
});

describe('registerModelModifier (custom)', () => {
    it('applies a custom value transform via the public API', () => {
        const off = registerModelModifier('uppercase', {
            transform: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
        });
        try {
            expect(applyModelTransforms('hi', { uppercase: true })).toBe('HI');
        } finally {
            off();
        }
        // Unregister removes it.
        expect(getModelModifier('uppercase')).toBeUndefined();
        expect(applyModelTransforms('hi', { uppercase: true })).toBe('hi');
    });

    it('supports a custom timing modifier', () => {
        const off = registerModelModifier('eager', { timing: 'lazy' });
        try {
            expect(resolveTiming({ eager: true }).lazy).toBe(true);
        } finally {
            off();
        }
    });
});

describe('wrapModelWriteBack', () => {
    it('returns the handler untouched when there are no modifiers', () => {
        const fn = (_: any) => {};
        expect(wrapModelWriteBack(fn, undefined)).toBe(fn);
    });

    it('applies transforms before the real write and carries the modifiers tag', () => {
        const writes: any[] = [];
        const wrapped = wrapModelWriteBack((v) => writes.push(v), { trim: true });
        wrapped('  spaced  ');
        expect(writes).toEqual(['spaced']);
        // Tag is readable by the platform even for timing-only modifiers.
        expect(getHandlerModifiers(wrapped)).toEqual({ trim: true });
        const timingOnly = wrapModelWriteBack(() => {}, { debounce: 200 });
        expect(getHandlerModifiers(timingOnly)).toEqual({ debounce: 200 });
    });
});

describe('createDebounceScheduler', () => {
    it('fires trailing-edge with the latest value and can cancel', () => {
        vi.useFakeTimers();
        try {
            const writes: any[] = [];
            const s = createDebounceScheduler((v) => writes.push(v), 200);
            s.invoke('a');
            s.invoke('b');
            vi.advanceTimersByTime(199);
            expect(writes).toEqual([]);
            vi.advanceTimersByTime(1);
            expect(writes).toEqual(['b']);

            s.invoke('c');
            s.cancel();
            vi.advanceTimersByTime(500);
            expect(writes).toEqual(['b']); // cancelled write never lands
        } finally {
            vi.useRealTimers();
        }
    });
});
