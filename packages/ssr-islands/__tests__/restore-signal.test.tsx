/**
 * Tests for client/restore-signal.ts — the client counterpart to the server's
 * createTrackingSignal. Seeds island signals from server-captured state during
 * hydration (#120) while staying a normal live signal afterwards.
 */

import { describe, it, expect } from 'vitest';
import { effect } from 'sigx';
import { createRestoringSignal } from '../src/client/restore-signal';
import type { SSRSignalFn } from '../src/server/render-component';

describe('createRestoringSignal', () => {
    it('seeds a named signal from state by key', () => {
        const restore = createRestoringSignal({ count: 7 }) as SSRSignalFn;
        const count = restore(0, 'count');
        // Restored value wins over the literal initial.
        expect(count.value).toBe(7);
    });

    it('falls back to the literal initial when the key is absent', () => {
        const restore = createRestoringSignal({ other: 1 }) as SSRSignalFn;
        const count = restore(42, 'count');
        expect(count.value).toBe(42);
    });

    it('uses positional $index keys for unnamed signals (matches server)', () => {
        const restore = createRestoringSignal({ $0: 'a', $1: 'b' }) as SSRSignalFn;
        const first = restore('x');
        const second = restore('y');
        expect(first.value).toBe('a');
        expect(second.value).toBe('b');
    });

    it('restores object-form signals via the .value convention', () => {
        // Object signals expose state under `.value` (same shape the server's
        // tracking signal normalizes to — see TestAsyncCounter's `{ value: 0 }`).
        const restore = createRestoringSignal({ obj: { value: 5 } }) as SSRSignalFn;
        const obj = restore({ value: 0 }, 'obj');
        expect(obj.value).toBe(5);
    });

    it('produces a live signal — writes drive reactivity', () => {
        const restore = createRestoringSignal({ n: 10 }) as SSRSignalFn;
        const n = restore(0, 'n');

        const seen: number[] = [];
        effect(() => { seen.push(n.value as number); });
        expect(seen).toEqual([10]);

        n.value = 11;
        expect(n.value).toBe(11);
        expect(seen).toEqual([10, 11]);
    });

    it('supports reads/writes of non-value props on the proxy', () => {
        const restore = createRestoringSignal({}) as SSRSignalFn;
        const sig: any = restore(0, 'm');
        sig.custom = 'hello';
        expect(sig.custom).toBe('hello');
    });
});
