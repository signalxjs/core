import { describe, it, expect, vi } from 'vitest';
import { signal, effect, isReactive, toRaw } from '../src/index';

describe('Collection Reactivity - Set', () => {
    describe('basic operations', () => {
        it('should create a reactive Set', () => {
            const set = signal(new Set([1, 2, 3]));
            expect(isReactive(set)).toBe(true);
        });

        it('should track size', () => {
            const set = signal(new Set([1, 2]));
            let size = 0;

            effect(() => {
                size = set.size;
            });

            expect(size).toBe(2);
            set.add(3);
            expect(size).toBe(3);
        });

        it('should track has()', () => {
            const set = signal(new Set([1, 2]));
            let hasThree = false;

            effect(() => {
                hasThree = set.has(3);
            });

            expect(hasThree).toBe(false);
            set.add(3);
            expect(hasThree).toBe(true);
        });

        it('should trigger effects on add()', () => {
            const set = signal(new Set<number>());
            const fn = vi.fn();

            effect(() => {
                void set.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            set.add(1);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on delete()', () => {
            const set = signal(new Set([1, 2, 3]));
            const fn = vi.fn();

            effect(() => {
                void set.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            set.delete(2);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on clear()', () => {
            const set = signal(new Set([1, 2, 3]));
            const fn = vi.fn();

            effect(() => {
                void set.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            set.clear();
            expect(fn).toHaveBeenCalledTimes(2);
            expect(set.size).toBe(0);
        });
    });

    describe('iteration', () => {
        it('should track forEach', () => {
            const set = signal(new Set([1, 2, 3]));
            let sum = 0;

            effect(() => {
                sum = 0;
                set.forEach(v => { sum += v; });
            });

            expect(sum).toBe(6);
            set.add(4);
            expect(sum).toBe(10);
        });

        it('should track values()', () => {
            const set = signal(new Set([1, 2, 3]));
            let values: number[] = [];

            effect(() => {
                values = [...set.values()];
            });

            expect(values).toEqual([1, 2, 3]);
            set.add(4);
            expect(values).toEqual([1, 2, 3, 4]);
        });

        it('should track Symbol.iterator', () => {
            const set = signal(new Set([1, 2, 3]));
            let values: number[] = [];

            effect(() => {
                values = [...set];
            });

            expect(values).toEqual([1, 2, 3]);
            set.delete(2);
            expect(values).toEqual([1, 3]);
        });
    });
});

describe('Collection Reactivity - Map', () => {
    describe('basic operations', () => {
        it('should create a reactive Map', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            expect(isReactive(map)).toBe(true);
        });

        it('should track size', () => {
            const map = signal(new Map([['a', 1]]));
            let size = 0;

            effect(() => {
                size = map.size;
            });

            expect(size).toBe(1);
            map.set('b', 2);
            expect(size).toBe(2);
        });

        it('should track get()', () => {
            const map = signal(new Map([['a', 1]]));
            let value: number | undefined;

            effect(() => {
                value = map.get('a');
            });

            expect(value).toBe(1);
            map.set('a', 10);
            expect(value).toBe(10);
        });

        it('should track has()', () => {
            const map = signal(new Map([['a', 1]]));
            let hasB = false;

            effect(() => {
                hasB = map.has('b');
            });

            expect(hasB).toBe(false);
            map.set('b', 2);
            expect(hasB).toBe(true);
        });

        it('should trigger effects on set()', () => {
            const map = signal(new Map<string, number>());
            const fn = vi.fn();

            effect(() => {
                void map.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            map.set('a', 1);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on delete()', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            const fn = vi.fn();

            effect(() => {
                void map.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            map.delete('a');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on clear()', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            const fn = vi.fn();

            effect(() => {
                void map.size;
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            map.clear();
            expect(fn).toHaveBeenCalledTimes(2);
            expect(map.size).toBe(0);
        });
    });

    describe('iteration', () => {
        it('should track forEach', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            let sum = 0;

            effect(() => {
                sum = 0;
                map.forEach(v => { sum += v; });
            });

            expect(sum).toBe(3);
            map.set('c', 3);
            expect(sum).toBe(6);
        });

        it('should track keys()', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            let keys: string[] = [];

            effect(() => {
                keys = [...map.keys()];
            });

            expect(keys).toEqual(['a', 'b']);
            map.set('c', 3);
            expect(keys).toEqual(['a', 'b', 'c']);
        });

        it('should track values() for iteration changes', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            let values: number[] = [];

            effect(() => {
                values = [...map.values()];
            });

            expect(values).toEqual([1, 2]);
            // Adding a new key triggers iteration tracking
            map.set('c', 3);
            expect(values).toEqual([1, 2, 3]);
            // Deleting a key also triggers iteration tracking
            map.delete('a');
            expect(values).toEqual([2, 3]);
        });

        it('should track entries()', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            let entries: [string, number][] = [];

            effect(() => {
                entries = [...map.entries()];
            });

            expect(entries).toEqual([['a', 1], ['b', 2]]);
            map.delete('a');
            expect(entries).toEqual([['b', 2]]);
        });

        it('should track Symbol.iterator', () => {
            const map = signal(new Map([['a', 1], ['b', 2]]));
            let entries: [string, number][] = [];

            effect(() => {
                entries = [...map];
            });

            expect(entries).toEqual([['a', 1], ['b', 2]]);
            map.set('c', 3);
            expect(entries).toEqual([['a', 1], ['b', 2], ['c', 3]]);
        });
    });
});

describe('toRaw with collections', () => {
    it('should return raw Set', () => {
        const rawSet = new Set([1, 2, 3]);
        const reactiveSet = signal(rawSet);
        expect(toRaw(reactiveSet)).toBe(rawSet);
    });

    it('should return raw Map', () => {
        const rawMap = new Map([['a', 1]]);
        const reactiveMap = signal(rawMap);
        expect(toRaw(reactiveMap)).toBe(rawMap);
    });
});
