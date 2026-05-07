import { describe, it, expect, vi } from 'vitest';
import { signal, effect, isReactive, toRaw, batch } from '../src/index';

describe('signal', () => {
    describe('basic reactivity', () => {
        it('should create a reactive proxy from an object', () => {
            const state = signal({ count: 0 });
            expect(state.count).toBe(0);
            expect(isReactive(state)).toBe(true);
        });

        it('should update values through the proxy', () => {
            const state = signal({ count: 0 });
            state.count = 5;
            expect(state.count).toBe(5);
        });

        it('should make nested objects reactive', () => {
            const state = signal({ user: { name: 'John' } });
            expect(isReactive(state.user)).toBe(true);
            state.user.name = 'Jane';
            expect(state.user.name).toBe('Jane');
        });

        it('should return the same proxy for the same object', () => {
            const obj = { count: 0 };
            const s1 = signal(obj);
            const s2 = signal(obj);
            expect(s1).toBe(s2);
        });

        it('should return the same proxy if already reactive', () => {
            const state = signal({ count: 0 });
            const same = signal(state);
            expect(state).toBe(same);
        });
    });

    describe('$set method', () => {
        it('should replace all properties with $set on objects', () => {
            const state = signal({ a: 1, b: 2 });
            state.$set({ a: 10, c: 3 } as any);
            expect(state.a).toBe(10);
            expect((state as any).c).toBe(3);
            expect((state as any).b).toBeUndefined();
        });

        it('should replace array contents with $set', () => {
            const state = signal([1, 2, 3]);
            state.$set([4, 5]);
            expect(state[0]).toBe(4);
            expect(state[1]).toBe(5);
            expect(state.length).toBe(2);
        });
    });

    describe('arrays', () => {
        it('should track array index access', () => {
            const arr = signal([1, 2, 3]);
            let value: number = 0;
            effect(() => {
                value = arr[0];
            });
            expect(value).toBe(1);
            arr[0] = 10;
            expect(value).toBe(10);
        });

        it('should track array length', () => {
            const arr = signal([1, 2, 3]);
            let length = 0;
            effect(() => {
                length = arr.length;
            });
            expect(length).toBe(3);
            arr.push(4);
            expect(length).toBe(4);
        });

        it('should batch array mutating methods', () => {
            const arr = signal([1, 2, 3]);
            let runCount = 0;
            effect(() => {
                void arr.length;
                runCount++;
            });
            // Initial run
            expect(runCount).toBe(1);
            // Push is batched, so effect runs once after push
            arr.push(4, 5, 6);
            expect(runCount).toBe(2);
        });

        // --- Identity-based search methods (the real bug: objects fail identity checks) ---

        describe('includes', () => {
            it('should find primitive values', () => {
                const arr = signal(['a', 'b', 'c']);
                expect(arr.includes('b')).toBe(true);
                expect(arr.includes('z')).toBe(false);
            });

            it('should find raw object references in reactive array', () => {
                const obj1 = { id: 1 };
                const obj2 = { id: 2 };
                const arr = signal([obj1, obj2]);
                // This is the core bug: proxy-wrapped elements fail === against raw objects
                expect(arr.includes(obj1)).toBe(true);
                expect(arr.includes(obj2)).toBe(true);
                expect(arr.includes({ id: 1 })).toBe(false); // different ref, should be false
            });
        });

        describe('indexOf', () => {
            it('should return correct index for primitives', () => {
                const arr = signal([10, 20, 30]);
                expect(arr.indexOf(20)).toBe(1);
                expect(arr.indexOf(99)).toBe(-1);
            });

            it('should return correct index for raw object references', () => {
                const obj = { id: 1 };
                const arr = signal([{ id: 0 }, obj, { id: 2 }]);
                expect(arr.indexOf(obj)).toBe(1);
            });
        });

        describe('lastIndexOf', () => {
            it('should return correct last index for raw object references', () => {
                const obj = { id: 1 };
                const arr = signal([obj, { id: 2 }, obj]);
                expect(arr.lastIndexOf(obj)).toBe(2);
            });
        });

        // --- Iteration/callback methods ---

        describe('filter', () => {
            it('should filter primitives', () => {
                const arr = signal([1, 2, 3, 4, 5]);
                const result = arr.filter((x: number) => x > 3);
                expect(result).toEqual([4, 5]);
            });

            it('should filter objects', () => {
                const arr = signal([{ active: true }, { active: false }, { active: true }]);
                const result = arr.filter((x: { active: boolean }) => x.active);
                expect(result).toHaveLength(2);
            });
        });

        describe('find / findIndex', () => {
            it('should find an element', () => {
                const arr = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
                const found = arr.find((x: { id: number }) => x.id === 2);
                expect(found).toBeTruthy();
                expect(toRaw(found)!.id).toBe(2);
            });

            it('should return correct findIndex', () => {
                const arr = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
                expect(arr.findIndex((x: { id: number }) => x.id === 2)).toBe(1);
                expect(arr.findIndex((x: { id: number }) => x.id === 99)).toBe(-1);
            });
        });

        describe('some / every', () => {
            it('some should return true when at least one matches', () => {
                const arr = signal([1, 2, 3]);
                expect(arr.some((x: number) => x === 2)).toBe(true);
                expect(arr.some((x: number) => x === 99)).toBe(false);
            });

            it('every should return true when all match', () => {
                const arr = signal([2, 4, 6]);
                expect(arr.every((x: number) => x % 2 === 0)).toBe(true);
                expect(arr.every((x: number) => x > 3)).toBe(false);
            });
        });

        describe('map / forEach', () => {
            it('should map values', () => {
                const arr = signal([1, 2, 3]);
                const result = arr.map((x: number) => x * 2);
                expect(result).toEqual([2, 4, 6]);
            });

            it('should iterate with forEach', () => {
                const arr = signal([1, 2, 3]);
                const collected: number[] = [];
                arr.forEach((x: number) => collected.push(x));
                expect(collected).toEqual([1, 2, 3]);
            });
        });

        describe('reduce', () => {
            it('should reduce values', () => {
                const arr = signal([1, 2, 3, 4]);
                const sum = arr.reduce((acc: number, x: number) => acc + x, 0);
                expect(sum).toBe(10);
            });
        });

        describe('concat / slice / join', () => {
            it('should concat arrays', () => {
                const arr = signal([1, 2]);
                const result = arr.concat([3, 4]);
                expect(result).toEqual([1, 2, 3, 4]);
            });

            it('should slice arrays', () => {
                const arr = signal([1, 2, 3, 4]);
                expect(arr.slice(1, 3)).toEqual([2, 3]);
            });

            it('should join arrays', () => {
                const arr = signal(['a', 'b', 'c']);
                expect(arr.join('-')).toBe('a-b-c');
            });
        });

        // --- Dependency tracking with read methods ---

        describe('dependency tracking with includes', () => {
            it('should re-run effect when array changes and includes result changes', () => {
                const arr = signal(['a', 'b']);
                let hasC = false;
                effect(() => {
                    hasC = arr.includes('c');
                });
                expect(hasC).toBe(false);
                arr.push('c');
                expect(hasC).toBe(true);
            });
        });
    });

    describe('toRaw', () => {
        it('should return the raw object from a reactive proxy', () => {
            const raw = { count: 0 };
            const state = signal(raw);
            expect(toRaw(state)).toBe(raw);
        });

        it('should return the value as-is if not reactive', () => {
            const obj = { count: 0 };
            expect(toRaw(obj)).toBe(obj);
        });
    });

    describe('delete property', () => {
        it('should trigger effects when a property is deleted', () => {
            const state = signal({ a: 1, b: 2 }) as any;
            let aValue: number | undefined;
            effect(() => {
                aValue = state.a;
            });
            expect(aValue).toBe(1);
            delete state.a;
            expect(aValue).toBeUndefined();
        });
    });

    describe('primitive values', () => {
        it('should wrap number in { value: number }', () => {
            const num = signal(42);
            expect(num.value).toBe(42);
            expect(isReactive(num)).toBe(true);
        });

        it('should wrap string in { value: string }', () => {
            const str = signal('hello');
            expect(str.value).toBe('hello');
            expect(isReactive(str)).toBe(true);
        });

        it('should wrap boolean in { value: boolean }', () => {
            const bool = signal(true);
            expect(bool.value).toBe(true);
            expect(isReactive(bool)).toBe(true);
        });

        it('should wrap null in { value: null }', () => {
            const nullSignal = signal(null);
            expect(nullSignal.value).toBe(null);
            expect(isReactive(nullSignal)).toBe(true);
        });

        it('should wrap undefined in { value: undefined }', () => {
            const undefinedSignal = signal(undefined);
            expect(undefinedSignal.value).toBe(undefined);
            expect(isReactive(undefinedSignal)).toBe(true);
        });

        it('should be reactive when value changes', () => {
            const count = signal(0);
            let effectValue = -1;
            effect(() => {
                effectValue = count.value;
            });
            expect(effectValue).toBe(0);
            count.value = 10;
            expect(effectValue).toBe(10);
        });

        it('should track multiple changes to primitive signal', () => {
            const name = signal('Alice');
            const fn = vi.fn();
            effect(() => {
                fn(name.value);
            });
            expect(fn).toHaveBeenCalledWith('Alice');
            name.value = 'Bob';
            expect(fn).toHaveBeenCalledWith('Bob');
            name.value = 'Charlie';
            expect(fn).toHaveBeenCalledWith('Charlie');
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('should not trigger if primitive value does not change', () => {
            const count = signal(5);
            const fn = vi.fn();
            effect(() => {
                fn(count.value);
            });
            expect(fn).toHaveBeenCalledTimes(1);
            count.value = 5; // Same value
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should work with bigint primitive', () => {
            const big = signal(BigInt(9007199254740991));
            expect(big.value).toBe(BigInt(9007199254740991));
            big.value = BigInt(123);
            expect(big.value).toBe(BigInt(123));
        });

        it('should work with symbol primitive', () => {
            const sym = Symbol('test');
            const symSignal = signal(sym);
            expect(symSignal.value).toBe(sym);
        });
    });
});

describe('effect', () => {
    it('should run immediately', () => {
        const fn = vi.fn();
        effect(fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should re-run when tracked dependencies change', () => {
        const state = signal({ count: 0 });
        const fn = vi.fn();
        effect(() => {
            fn(state.count);
        });
        expect(fn).toHaveBeenCalledWith(0);
        state.count = 1;
        expect(fn).toHaveBeenCalledWith(1);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should stop tracking when stopped', () => {
        const state = signal({ count: 0 });
        const fn = vi.fn();
        const runner = effect(() => {
            fn(state.count);
        });
        expect(fn).toHaveBeenCalledTimes(1);
        runner.stop();
        state.count = 5;
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should track multiple dependencies', () => {
        const state = signal({ a: 1, b: 2 });
        let sum = 0;
        effect(() => {
            sum = state.a + state.b;
        });
        expect(sum).toBe(3);
        state.a = 10;
        expect(sum).toBe(12);
        state.b = 20;
        expect(sum).toBe(30);
    });

    it('should not trigger if value does not change', () => {
        const state = signal({ count: 0 });
        const fn = vi.fn();
        effect(() => {
            fn(state.count);
        });
        expect(fn).toHaveBeenCalledTimes(1);
        state.count = 0; // Same value
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('batch', () => {
    it('should batch multiple updates into one effect run', () => {
        const state = signal({ a: 0, b: 0 });
        let runCount = 0;
        effect(() => {
            void state.a;
            void state.b;
            runCount++;
        });
        expect(runCount).toBe(1);

        batch(() => {
            state.a = 1;
            state.b = 2;
        });

        expect(runCount).toBe(2);
    });

    it('should run nested batches correctly', () => {
        const state = signal({ count: 0 });
        let runCount = 0;
        effect(() => {
            void state.count;
            runCount++;
        });
        expect(runCount).toBe(1);

        batch(() => {
            state.count = 1;
            batch(() => {
                state.count = 2;
            });
            state.count = 3;
        });

        // Only runs once at the end of outer batch
        expect(runCount).toBe(2);
        expect(state.count).toBe(3);
    });
});
