/**
 * Tests for server/render-component.ts — the island tracking-signal factory and
 * state serialization.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createTrackingSignal,
    serializeSignalState,
    type SSRSignalFn
} from '../src/server/render-component';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('serializeSignalState', () => {
    it('returns undefined for an empty signal map', () => {
        expect(serializeSignalState(new Map())).toBeUndefined();
    });

    it('serializes serializable values', () => {
        const map = new Map<string, any>([['count', 3], ['name', 'a']]);
        expect(serializeSignalState(map)).toEqual({ count: 3, name: 'a' });
    });

    it('skips non-serializable (circular) values and warns', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const circular: any = {};
        circular.self = circular;

        const map = new Map<string, any>([['ok', 1], ['bad', circular]]);
        const result = serializeSignalState(map);

        expect(result).toEqual({ ok: 1 });
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('bad');
    });

    it('returns undefined when every value is non-serializable', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const circular: any = {};
        circular.self = circular;
        expect(serializeSignalState(new Map([['bad', circular]]))).toBeUndefined();
    });
});

describe('createTrackingSignal', () => {
    it('captures the initial value into the signal map under a named key', () => {
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const sig = ssrSignal({ value: 5 }, 'count');
        expect(sig.value).toBe(5);
        expect(map.get('count')).toEqual({ value: 5 });
    });

    it('tracks writes to .value back into the signal map', () => {
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const sig = ssrSignal(0 as any, 'n');
        (sig as any).value = 42;
        expect(map.get('n')).toBe(42);
        expect(sig.value).toBe(42);
    });

    it('supports reads and writes of non-value props on the proxy', () => {
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const sig: any = ssrSignal(0 as any, 'm');
        sig.custom = 'hello';
        expect(sig.custom).toBe('hello');
        // Writing a non-value prop does not pollute the captured state.
        expect(map.get('m')).toBe(0);
    });

    it('warns once for an unnamed signal (fragile positional key) and uses a $index key', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        ssrSignal(1 as any); // unnamed → positional key "$0", warns
        ssrSignal(2 as any); // unnamed again → "$1", but warns only once

        expect(map.get('$0')).toBe(1);
        expect(map.get('$1')).toBe(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to String() in the dev hint when initial is circular', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const circular: any = {};
        circular.self = circular;
        // Unnamed + circular initial → JSON.stringify in the hint throws and is
        // caught, falling back to String(initial). Must not throw.
        expect(() => ssrSignal(circular)).not.toThrow();
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});
