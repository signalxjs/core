/**
 * Comprehensive tests for ALL array methods on reactive arrays.
 *
 * Covers methods that were missing from the original test suite:
 * - flat, flatMap
 * - reduceRight
 * - Iterator protocol: Symbol.iterator, for...of, entries, keys, values
 * - Spread operator, destructuring, Array.from
 * - at, findLast, findLastIndex (ES2022+)
 * - copyWithin, fill
 * - toString, toLocaleString
 * - Dependency tracking for iteration methods
 */
import { describe, it, expect } from 'vitest';
import { signal, effect, toRaw } from '../src/index';

describe('reactive array — complete method coverage', () => {

    // ========================================================================
    // flat / flatMap
    // ========================================================================

    describe('flat', () => {
        it('should flatten one level by default', () => {
            const arr = signal([1, [2, 3], [4, [5]]]);
            expect(arr.flat()).toEqual([1, 2, 3, 4, [5]]);
        });

        it('should flatten deeply with Infinity', () => {
            const arr = signal([1, [2, [3, [4, [5]]]]]);
            expect(arr.flat(Infinity)).toEqual([1, 2, 3, 4, 5]);
        });

        it('should flatten specified depth', () => {
            const arr = signal([1, [2, [3, [4]]]]);
            expect(arr.flat(2)).toEqual([1, 2, 3, [4]]);
        });

        it('should handle empty arrays', () => {
            const arr = signal([] as number[][]);
            expect(arr.flat()).toEqual([]);
        });
    });

    describe('flatMap', () => {
        it('should map and flatten one level', () => {
            const arr = signal([1, 2, 3]);
            expect(arr.flatMap((x: number) => [x, x * 2])).toEqual([1, 2, 2, 4, 3, 6]);
        });

        it('should handle mapping to empty arrays (filtering pattern)', () => {
            const arr = signal([1, 2, 3, 4, 5]);
            const result = arr.flatMap((x: number) => x % 2 === 0 ? [x] : []);
            expect(result).toEqual([2, 4]);
        });

        it('should not flatten beyond one level', () => {
            const arr = signal([1, 2]);
            const result = arr.flatMap((x: number) => [[x]]);
            expect(result).toEqual([[1], [2]]);
        });
    });

    // ========================================================================
    // reduceRight
    // ========================================================================

    describe('reduceRight', () => {
        it('should reduce from right to left', () => {
            const arr = signal(['a', 'b', 'c']);
            expect(arr.reduceRight((acc: string, x: string) => acc + x, '')).toBe('cba');
        });

        it('should reduce numbers', () => {
            const arr = signal([1, 2, 3, 4]);
            expect(arr.reduceRight((acc: number, x: number) => acc - x, 10)).toBe(0);
        });

        it('should work without initial value', () => {
            const arr = signal([1, 2, 3]);
            expect(arr.reduceRight((acc: number, x: number) => acc + x)).toBe(6);
        });
    });

    // ========================================================================
    // Iterator protocol: for...of, spread, destructuring, Array.from
    // ========================================================================

    describe('Symbol.iterator / for...of', () => {
        it('should iterate with for...of', () => {
            const arr = signal([10, 20, 30]);
            const collected: number[] = [];
            for (const x of arr) {
                collected.push(x);
            }
            expect(collected).toEqual([10, 20, 30]);
        });

        it('should work with spread operator', () => {
            const arr = signal([7, 8, 9]);
            expect([...arr]).toEqual([7, 8, 9]);
        });

        it('should work with array destructuring', () => {
            const arr = signal([100, 200, 300]);
            const [a, b, c] = arr;
            expect(a).toBe(100);
            expect(b).toBe(200);
            expect(c).toBe(300);
        });

        it('should work with Array.from', () => {
            const arr = signal([4, 5, 6]);
            expect(Array.from(arr)).toEqual([4, 5, 6]);
        });

        it('should iterate objects (returning reactive proxies)', () => {
            const arr = signal([{ id: 1 }, { id: 2 }]);
            const ids: number[] = [];
            for (const item of arr) {
                ids.push(item.id);
            }
            expect(ids).toEqual([1, 2]);
        });
    });

    describe('entries / keys / values', () => {
        it('should iterate entries', () => {
            const arr = signal(['a', 'b', 'c']);
            const entries = [...arr.entries()];
            expect(entries).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
        });

        it('should iterate keys', () => {
            const arr = signal([10, 20, 30]);
            expect([...arr.keys()]).toEqual([0, 1, 2]);
        });

        it('should iterate values', () => {
            const arr = signal([10, 20, 30]);
            expect([...arr.values()]).toEqual([10, 20, 30]);
        });
    });

    // ========================================================================
    // ES2022+ methods: at, findLast, findLastIndex
    // ========================================================================

    describe('at', () => {
        it('should access positive index', () => {
            const arr = signal([10, 20, 30]);
            expect(arr.at(0)).toBe(10);
            expect(arr.at(2)).toBe(30);
        });

        it('should access negative index', () => {
            const arr = signal([10, 20, 30]);
            expect(arr.at(-1)).toBe(30);
            expect(arr.at(-2)).toBe(20);
        });

        it('should return undefined for out of bounds', () => {
            const arr = signal([1, 2]);
            expect(arr.at(5)).toBeUndefined();
        });
    });

    describe('findLast / findLastIndex', () => {
        it('should find last matching element', () => {
            const arr = signal([1, 2, 3, 4, 5]);
            expect(arr.findLast((x: number) => x % 2 === 0)).toBe(4);
        });

        it('should return undefined if no match', () => {
            const arr = signal([1, 3, 5]);
            expect(arr.findLast((x: number) => x % 2 === 0)).toBeUndefined();
        });

        it('should find last matching index', () => {
            const arr = signal([1, 2, 3, 2, 1]);
            expect(arr.findLastIndex((x: number) => x === 2)).toBe(3);
        });

        it('should return -1 if no match', () => {
            const arr = signal([1, 2, 3]);
            expect(arr.findLastIndex((x: number) => x === 99)).toBe(-1);
        });
    });

    // ========================================================================
    // Mutating methods not yet covered: copyWithin, fill
    // ========================================================================

    describe('copyWithin', () => {
        it('should copy within the array', () => {
            const arr = signal([1, 2, 3, 4, 5]);
            arr.copyWithin(0, 3);
            expect([...arr]).toEqual([4, 5, 3, 4, 5]);
        });
    });

    describe('fill', () => {
        it('should fill the array', () => {
            const arr = signal([1, 2, 3, 4]);
            arr.fill(0, 1, 3);
            expect([...arr]).toEqual([1, 0, 0, 4]);
        });
    });

    // ========================================================================
    // toString / toLocaleString
    // ========================================================================

    describe('toString / toLocaleString', () => {
        it('should convert to string', () => {
            const arr = signal([1, 2, 3]);
            expect(arr.toString()).toBe('1,2,3');
        });

        it('should convert to locale string', () => {
            const arr = signal([1, 2, 3]);
            expect(typeof arr.toLocaleString()).toBe('string');
        });
    });

    // ========================================================================
    // Dependency tracking — effects re-run when array mutates
    // ========================================================================

    describe('dependency tracking for iteration', () => {
        it('should re-run effect using for...of when array changes', () => {
            const arr = signal([1, 2]);
            let sum = 0;
            effect(() => {
                sum = 0;
                for (const x of arr) sum += x;
            });
            expect(sum).toBe(3);
            arr.push(3);
            expect(sum).toBe(6);
        });

        it('should re-run effect using spread when array changes', () => {
            const arr = signal([1, 2]);
            let copy: number[] = [];
            effect(() => {
                copy = [...arr];
            });
            expect(copy).toEqual([1, 2]);
            arr.push(3);
            expect(copy).toEqual([1, 2, 3]);
        });

        it('should re-run effect using entries when array changes', () => {
            const arr = signal(['a']);
            let entries: [number, string][] = [];
            effect(() => {
                entries = [...arr.entries()];
            });
            expect(entries).toEqual([[0, 'a']]);
            arr.push('b');
            expect(entries).toEqual([[0, 'a'], [1, 'b']]);
        });

        it('should re-run effect using flat when array changes', () => {
            const arr = signal([[1], [2]]) as any;
            let flat: number[] = [];
            effect(() => {
                flat = arr.flat();
            });
            expect(flat).toEqual([1, 2]);
            arr.push([3]);
            expect(flat).toEqual([1, 2, 3]);
        });

        it('should re-run effect using flatMap when array changes', () => {
            const arr = signal([1, 2]);
            let result: number[] = [];
            effect(() => {
                result = arr.flatMap((x: number) => [x, x * 10]);
            });
            expect(result).toEqual([1, 10, 2, 20]);
            arr.push(3);
            expect(result).toEqual([1, 10, 2, 20, 3, 30]);
        });

        it('should re-run effect using reduceRight when array changes', () => {
            const arr = signal(['a', 'b']);
            let result = '';
            effect(() => {
                result = arr.reduceRight((acc: string, x: string) => acc + x, '');
            });
            expect(result).toBe('ba');
            arr.push('c');
            expect(result).toBe('cba');
        });
    });
});
