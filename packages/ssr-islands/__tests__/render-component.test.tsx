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

    it('leaves an unkeyed signal local-only: live but never captured, no warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const sig = ssrSignal(1 as any); // no key → plain local signal
        expect(sig.value).toBe(1);
        (sig as any).value = 2;
        expect(sig.value).toBe(2);

        expect(map.size).toBe(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('duplicate key: first wins, later ones stay local-only with a dev warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const map = new Map<string, any>();
        const ssrSignal = createTrackingSignal(map) as SSRSignalFn;

        const first = ssrSignal(1 as any, 'n');
        const second = ssrSignal(2 as any, 'n');

        // Only the first occupies the key; the duplicate is live but untracked.
        (first as any).value = 10;
        (second as any).value = 20;
        expect(map.get('n')).toBe(10);
        expect(map.size).toBe(1);
        expect(second.value).toBe(20);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('Duplicate state key "n"');
    });
});
