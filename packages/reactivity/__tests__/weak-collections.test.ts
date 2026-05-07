import { describe, it, expect, vi } from 'vitest';
import { signal, effect, isReactive, toRaw } from '../src/index';

describe('Collection Reactivity - WeakSet', () => {
    describe('basic operations', () => {
        it('should create a reactive WeakSet', () => {
            const ws = signal(new WeakSet());
            expect(isReactive(ws)).toBe(true);
        });

        it('should track has() — adding value triggers effect', () => {
            const key = { id: 1 };
            const ws = signal(new WeakSet());
            let hasKey = false;

            effect(() => {
                hasKey = ws.has(key);
            });

            expect(hasKey).toBe(false);
            ws.add(key);
            expect(hasKey).toBe(true);
        });

        it('should trigger effects on add()', () => {
            const key = { id: 1 };
            const ws = signal(new WeakSet());
            const fn = vi.fn();

            effect(() => {
                ws.has(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            ws.add(key);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should not trigger extra effect when adding same value twice', () => {
            const key = { id: 1 };
            const ws = signal(new WeakSet());
            const fn = vi.fn();

            effect(() => {
                ws.has(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            ws.add(key);
            expect(fn).toHaveBeenCalledTimes(2);
            // Adding the same value again should not trigger
            ws.add(key);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on delete()', () => {
            const key = { id: 1 };
            const ws = signal(new WeakSet([key]));
            let hasKey = true;

            effect(() => {
                hasKey = ws.has(key);
            });

            expect(hasKey).toBe(true);
            ws.delete(key);
            expect(hasKey).toBe(false);
        });

        it('should not trigger when deleting non-existent key', () => {
            const key = { id: 1 };
            const other = { id: 2 };
            const ws = signal(new WeakSet([key]));
            const fn = vi.fn();

            effect(() => {
                ws.has(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            const result = ws.delete(other);
            expect(result).toBe(false);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should work with object keys', () => {
            const a = { name: 'a' };
            const b = { name: 'b' };
            const ws = signal(new WeakSet([a]));

            let hasA = false;
            let hasB = false;

            effect(() => {
                hasA = ws.has(a);
            });
            effect(() => {
                hasB = ws.has(b);
            });

            expect(hasA).toBe(true);
            expect(hasB).toBe(false);

            ws.add(b);
            expect(hasB).toBe(true);
            // hasA should remain unchanged
            expect(hasA).toBe(true);

            ws.delete(a);
            expect(hasA).toBe(false);
        });
    });
});

describe('Collection Reactivity - WeakMap', () => {
    describe('basic operations', () => {
        it('should create a reactive WeakMap', () => {
            const wm = signal(new WeakMap());
            expect(isReactive(wm)).toBe(true);
        });

        it('should track has()', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap());
            let hasKey = false;

            effect(() => {
                hasKey = wm.has(key);
            });

            expect(hasKey).toBe(false);
            wm.set(key, 'value');
            expect(hasKey).toBe(true);
        });

        it('should track get()', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>());
            let value: number | undefined;

            effect(() => {
                value = wm.get(key);
            });

            expect(value).toBeUndefined();
            wm.set(key, 42);
            expect(value).toBe(42);
        });

        it('should trigger effects on set() for tracked has()', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>());
            const fn = vi.fn();

            effect(() => {
                wm.has(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            wm.set(key, 1);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on set() for tracked get()', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>());
            const fn = vi.fn();

            effect(() => {
                wm.get(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            wm.set(key, 10);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should not trigger when setting same key with same value', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>([[key, 1]]));
            const fn = vi.fn();

            effect(() => {
                wm.get(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            // Same value — should not trigger (Object.is check)
            wm.set(key, 1);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should trigger when setting same key with different value', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>([[key, 1]]));
            const fn = vi.fn();

            effect(() => {
                wm.get(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            wm.set(key, 2);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should trigger effects on delete()', () => {
            const key = { id: 1 };
            const wm = signal(new WeakMap<object, number>([[key, 42]]));
            let hasKey = true;

            effect(() => {
                hasKey = wm.has(key);
            });

            expect(hasKey).toBe(true);
            wm.delete(key);
            expect(hasKey).toBe(false);
        });

        it('should not trigger when deleting non-existent key', () => {
            const key = { id: 1 };
            const other = { id: 2 };
            const wm = signal(new WeakMap<object, number>([[key, 1]]));
            const fn = vi.fn();

            effect(() => {
                wm.get(key);
                fn();
            });

            expect(fn).toHaveBeenCalledTimes(1);
            const result = wm.delete(other);
            expect(result).toBe(false);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should return reactive object from get() when value was made reactive', () => {
            const key = { id: 1 };
            const nested = { x: 1 };
            // Make nested reactive so rawToReactive has an entry
            const reactiveNested = signal(nested);

            const wm = signal(new WeakMap<object, any>());
            wm.set(key, reactiveNested);

            const retrieved = wm.get(key);
            expect(isReactive(retrieved)).toBe(true);
        });
    });
});

describe('toRaw with weak collections', () => {
    it('should return raw WeakSet', () => {
        const rawWS = new WeakSet();
        const reactiveWS = signal(rawWS);
        expect(toRaw(reactiveWS)).toBe(rawWS);
    });

    it('should return raw WeakMap', () => {
        const rawWM = new WeakMap();
        const reactiveWM = signal(rawWM);
        expect(toRaw(reactiveWM)).toBe(rawWM);
    });
});

describe('Cross-collection - reactive objects as keys', () => {
    it('should use reactive objects as WeakSet keys', () => {
        const rawKey = { id: 1 };
        const reactiveKey = signal(rawKey);
        const ws = signal(new WeakSet());

        let hasKey = false;
        effect(() => {
            hasKey = ws.has(reactiveKey);
        });

        expect(hasKey).toBe(false);
        // Adding with reactive key — instrumentation calls toRaw(key) internally
        ws.add(reactiveKey);
        expect(hasKey).toBe(true);
    });

    it('should use reactive objects as WeakMap keys', () => {
        const rawKey = { id: 1 };
        const reactiveKey = signal(rawKey);
        const wm = signal(new WeakMap<object, string>());

        let value: string | undefined;
        effect(() => {
            value = wm.get(reactiveKey);
        });

        expect(value).toBeUndefined();
        wm.set(reactiveKey, 'hello');
        expect(value).toBe('hello');
    });
});
