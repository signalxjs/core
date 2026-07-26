/**
 * Key-set reactivity (#521): enumerating a reactive object subscribes to its
 * KEY SET, so a key appearing or disappearing re-runs the reader. Reading a
 * value still subscribes per key — the two are separate deps, and the tests
 * below pin that separation in both directions.
 */

import { describe, it, expect, vi } from 'vitest';
import { signal, effect, computed } from '../src/index';

describe('key-set reactivity', () => {
    describe('ownKeys — enumeration', () => {
        it('re-runs Object.keys when a key is added', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(state)); });

            expect(seen).toEqual([['a']]);
            state.b = 2;
            expect(seen).toEqual([['a'], ['a', 'b']]);
        });

        it('re-runs Object.keys when a key is deleted', () => {
            const state = signal<Record<string, number>>({ a: 1, b: 2 });
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(state)); });

            delete state.b;
            expect(seen).toEqual([['a', 'b'], ['a']]);
        });

        it('re-runs a spread when a key is added', () => {
            const state = signal<Record<string, unknown>>({ a: 1 });
            const seen: Record<string, unknown>[] = [];
            effect(() => { seen.push({ ...state }); });

            state.b = 2;
            expect(seen).toEqual([{ a: 1 }, { a: 1, b: 2 }]);
        });

        it('re-runs rest destructuring when a key is added', () => {
            const state = signal<Record<string, unknown>>({ a: 1, b: 2 });
            const seen: Record<string, unknown>[] = [];
            effect(() => {
                const { a: _a, ...rest } = state;
                seen.push(rest);
            });

            expect(seen).toEqual([{ b: 2 }]);
            state.c = 3;
            expect(seen).toEqual([{ b: 2 }, { b: 2, c: 3 }]);
        });

        it('re-runs for…in when a key is added', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const seen: string[][] = [];
            effect(() => {
                const keys: string[] = [];
                for (const k in state) keys.push(k);
                seen.push(keys);
            });

            state.b = 2;
            expect(seen).toEqual([['a'], ['a', 'b']]);
        });

        it('does NOT re-run an enumerating reader when only a value changes', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const spy = vi.fn(() => Object.keys(state));
            effect(spy);

            expect(spy).toHaveBeenCalledTimes(1);
            state.a = 99;
            expect(spy).toHaveBeenCalledTimes(1);
        });

        // The key-set dep is additional, not a replacement: a spread copies
        // every value through the `get` trap, so it subscribes per key too.
        it('DOES re-run a spread when a value changes, via the per-key deps', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const seen: Record<string, number>[] = [];
            effect(() => { seen.push({ ...state }); });

            state.a = 99;
            expect(seen).toEqual([{ a: 1 }, { a: 99 }]);
        });

        it('re-assigning an existing key does not re-run an enumerating reader', () => {
            const state = signal<Record<string, number>>({ a: 1, b: 2 });
            const spy = vi.fn(() => Object.keys(state));
            effect(spy);

            state.b = 3;
            state.b = 4;
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('deleting a key that was never there does not re-run', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const spy = vi.fn(() => Object.keys(state));
            effect(spy);

            delete state.nope;
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('works through computed', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const count = computed(() => Object.keys(state).length);

            expect(count.value).toBe(1);
            state.b = 2;
            expect(count.value).toBe(2);
            delete state.a;
            expect(count.value).toBe(1);
        });
    });

    describe('a new key whose value is undefined', () => {
        // The key set changed even though Object.is(oldValue, newValue) is
        // true, which is why the add path sits outside that guard.
        it('re-runs an enumerating reader', () => {
            const state = signal<Record<string, unknown>>({ a: 1 });
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(state)); });

            state.b = undefined;
            expect(seen).toEqual([['a'], ['a', 'b']]);
        });

        it('re-runs a reader that had read the absent key, via `in`', () => {
            const state = signal<Record<string, unknown>>({ a: 1 });
            const seen: boolean[] = [];
            effect(() => { seen.push('b' in state); });

            state.b = undefined;
            expect(seen).toEqual([false, true]);
        });
    });

    describe('has — the `in` operator', () => {
        it('re-runs when the key appears', () => {
            const state = signal<Record<string, number>>({});
            const seen: boolean[] = [];
            effect(() => { seen.push('a' in state); });

            state.a = 1;
            expect(seen).toEqual([false, true]);
        });

        it('re-runs when the key is deleted', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const seen: boolean[] = [];
            effect(() => { seen.push('a' in state); });

            delete state.a;
            expect(seen).toEqual([true, false]);
        });

        it('does not re-run for an unrelated key', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            const spy = vi.fn(() => 'a' in state);
            effect(spy);

            state.other = 2;
            expect(spy).toHaveBeenCalledTimes(1);
        });
    });

    describe('$set', () => {
        it('re-runs an enumerating reader when $set adds and removes keys', () => {
            const state = signal<Record<string, number>>({ a: 1, b: 2 });
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(state)); });

            state.$set({ a: 1, c: 3 });
            expect(seen[seen.length - 1]).toEqual(['a', 'c']);
        });
    });

    describe('arrays key on length, not on an iteration dep', () => {
        it('re-runs an enumerating reader when an item is pushed', () => {
            const list = signal<number[]>([1]);
            const seen: number[][] = [];
            effect(() => { seen.push([...list]); });

            list.push(2);
            expect(seen).toEqual([[1], [1, 2]]);
        });

        it('re-runs Object.keys when the array grows', () => {
            const list = signal<number[]>([1]);
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(list)); });

            list.push(2);
            expect(seen).toEqual([['0'], ['0', '1']]);
        });

        it('does not re-run an enumerating reader when an index is replaced', () => {
            const list = signal<number[]>([1, 2]);
            const spy = vi.fn(() => Object.keys(list));
            effect(spy);

            list[0] = 9;
            expect(spy).toHaveBeenCalledTimes(1);
        });

        // `delete list[0]` leaves a hole: Object.keys loses '0' while length
        // stays 2, so routing the array key set to `length` has to fire on
        // delete even though length did not move.
        it('re-runs an enumerating reader when an index is deleted', () => {
            const list = signal<number[]>([1, 2]);
            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(list)); });

            delete list[0];
            expect(seen).toEqual([['0', '1'], ['1']]);
            expect(list.length).toBe(2);
        });

        it('re-runs a spread when an index is deleted', () => {
            const list = signal<(number | undefined)[]>([1, 2]);
            const seen: (number | undefined)[][] = [];
            effect(() => { seen.push([...list]); });

            delete list[0];
            expect(seen[seen.length - 1]).toEqual([undefined, 2]);
        });

        // The mirror case: filling the hole grows the key set back without
        // moving length.
        it('re-runs an enumerating reader when a hole is filled', () => {
            const list = signal<number[]>([1, 2]);
            delete list[0];

            const seen: string[][] = [];
            effect(() => { seen.push(Object.keys(list)); });
            expect(seen).toEqual([['1']]);

            list[0] = 7;
            expect(seen).toEqual([['1'], ['0', '1']]);
            expect(list.length).toBe(2);
        });
    });

    describe('collections keep their own iteration tracking', () => {
        it('a Map still re-runs on set/delete', () => {
            const map = signal(new Map<string, number>([['a', 1]]));
            const seen: number[] = [];
            effect(() => { seen.push(map.size); });

            map.set('b', 2);
            map.delete('a');
            expect(seen).toEqual([1, 2, 1]);
        });

        it('a Set still re-runs on add', () => {
            const set = signal(new Set<number>([1]));
            const seen: number[][] = [];
            effect(() => { seen.push([...set]); });

            set.add(2);
            expect(seen).toEqual([[1], [1, 2]]);
        });
    });

    describe('cost is gated on someone enumerating', () => {
        it('a plain write to a fresh signal allocates no iteration dep', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            // Nothing has enumerated, so the add path must not fire — proven
            // by a value-only reader seeing exactly one extra run.
            const spy = vi.fn(() => state.a);
            effect(spy);

            state.b = 2;
            expect(spy).toHaveBeenCalledTimes(1);
            state.a = 2;
            expect(spy).toHaveBeenCalledTimes(2);
        });

        it('an untracked enumeration creates no dep', () => {
            const state = signal<Record<string, number>>({ a: 1 });
            expect(Object.keys(state)).toEqual(['a']);

            const spy = vi.fn(() => state.a);
            effect(spy);
            state.b = 2;
            expect(spy).toHaveBeenCalledTimes(1);
        });
    });
});
