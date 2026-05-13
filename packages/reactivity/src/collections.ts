// ============================================================================
// Collection Reactivity Support (Set, Map, WeakSet, WeakMap)
// ============================================================================

import type { Subscriber } from './types';
import { track, trigger } from './effect';

/** Symbol for tracking iteration dependencies (forEach, keys, values, entries, size) */
export const ITERATION_KEY = Symbol('sigx:iterate');

/** WeakMap to get raw object from reactive proxy */
export const reactiveToRaw = new WeakMap<object, object>();

/** WeakMap to get reactive proxy from raw object */
export const rawToReactive = new WeakMap<object, object>();

/**
 * Returns the raw, original object from a reactive proxy.
 * If the value is not a proxy, returns it as-is.
 */
export function toRaw<T>(observed: T): T {
    const raw = reactiveToRaw.get(observed as object);
    return raw ? toRaw(raw as T) : observed;
}

/**
 * Checks if a value is a reactive proxy created by signal().
 */
export function isReactive(value: unknown): boolean {
    return reactiveToRaw.has(value as object);
}

/**
 * Checks if a value is a collection type (Set, Map, WeakSet, WeakMap).
 */
export function isCollection(value: unknown): value is Map<any, any> | Set<any> | WeakMap<any, any> | WeakSet<any> {
    if (!value || typeof value !== 'object') return false;
    const ctor = value.constructor;
    return ctor === Set || ctor === Map || ctor === WeakSet || ctor === WeakMap;
}

/**
 * Checks if a value is an iterable collection (Set or Map, not Weak variants).
 */
export function isIterableCollection(value: unknown): value is Map<any, any> | Set<any> {
    if (!value || typeof value !== 'object') return false;
    const ctor = value.constructor;
    return ctor === Set || ctor === Map;
}

/**
 * Checks if a value is an "exotic" built-in object that should NOT be proxied.
 * These objects have internal slots that cannot be accessed through Proxy.
 * Proxying them causes errors like "Method X called on incompatible receiver".
 */
export function shouldNotProxy(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    
    // Check against constructors of built-ins with internal slots
    const proto = Object.prototype.toString.call(value);
    
    // Built-ins that should not be proxied
    const nonProxyable = [
        '[object Date]',
        '[object RegExp]',
        '[object Error]',
        '[object Promise]',
        '[object ArrayBuffer]',
        '[object DataView]',
        '[object Int8Array]',
        '[object Uint8Array]',
        '[object Uint8ClampedArray]',
        '[object Int16Array]',
        '[object Uint16Array]',
        '[object Int32Array]',
        '[object Uint32Array]',
        '[object Float32Array]',
        '[object Float64Array]',
        '[object BigInt64Array]',
        '[object BigUint64Array]'
    ];
    
    return nonProxyable.includes(proto);
}

/**
 * Creates instrumented collection methods that properly handle reactivity.
 * These methods call the real collection methods on the raw object while
 * tracking dependencies and triggering updates.
 *
 * `notify` is the devtools update hook — called from every write method
 * so Map/Set mutations are visible to the panel. Pass a no-op when
 * devtools isn't relevant. The `key` argument it receives is a
 * stringifiable identifier for the affected slot (the mutated key for
 * `add`/`set`/`delete`, or a synthetic `'clear'` marker for `clear`).
 */
export function createCollectionInstrumentations(
    depsMap: Map<string | symbol, Set<Subscriber>>,
    getOrCreateDep: (key: string | symbol) => Set<Subscriber>,
    notify: (key: string | symbol) => void = () => {}
) {
    const instrumentations: Record<string | symbol, any> = {};

    // ---- READ METHODS (track dependencies) ----

    // has() - works on Set, Map, WeakSet, WeakMap
    instrumentations.has = function (this: any, key: unknown): boolean {
        const target = toRaw(this);
        const rawKey = toRaw(key);
        track(getOrCreateDep(rawKey as string | symbol));
        return target.has(rawKey);
    };

    // get() - works on Map, WeakMap
    instrumentations.get = function (this: any, key: unknown): any {
        const target = toRaw(this);
        const rawKey = toRaw(key);
        track(getOrCreateDep(rawKey as string | symbol));
        const value = target.get(rawKey);
        // Make the returned value reactive if it's an object
        if (value && typeof value === 'object') {
            return rawToReactive.get(value) || value;
        }
        return value;
    };

    // size - works on Set, Map (not WeakSet, WeakMap)
    Object.defineProperty(instrumentations, 'size', {
        get(this: any) {
            const target = toRaw(this);
            track(getOrCreateDep(ITERATION_KEY));
            return target.size;
        }
    });

    // forEach() - works on Set, Map
    instrumentations.forEach = function (this: any, callback: Function, thisArg?: unknown): void {
        const target = toRaw(this);
        track(getOrCreateDep(ITERATION_KEY));
        target.forEach((value: any, key: any) => {
            // Make values reactive when iterating
            const reactiveValue = (value && typeof value === 'object') 
                ? (rawToReactive.get(value) || value) 
                : value;
            const reactiveKey = (key && typeof key === 'object') 
                ? (rawToReactive.get(key) || key) 
                : key;
            callback.call(thisArg, reactiveValue, reactiveKey, this);
        });
    };

    // keys() - works on Set, Map
    instrumentations.keys = function (this: any): IterableIterator<any> {
        const target = toRaw(this);
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.keys();
        return createReactiveIterator(innerIterator, false);
    };

    // values() - works on Set, Map
    instrumentations.values = function (this: any): IterableIterator<any> {
        const target = toRaw(this);
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.values();
        return createReactiveIterator(innerIterator, true);
    };

    // entries() - works on Set, Map
    instrumentations.entries = function (this: any): IterableIterator<any> {
        const target = toRaw(this);
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.entries();
        return createReactiveEntriesIterator(innerIterator);
    };

    // [Symbol.iterator] - works on Set, Map
    instrumentations[Symbol.iterator] = function (this: any): IterableIterator<any> {
        const target = toRaw(this);
        track(getOrCreateDep(ITERATION_KEY));
        // Set uses values(), Map uses entries() for default iterator
        if (target instanceof Set) {
            return createReactiveIterator(target.values(), true);
        } else {
            return createReactiveEntriesIterator(target.entries());
        }
    };

    // ---- WRITE METHODS (trigger updates) ----

    // add() - works on Set, WeakSet
    instrumentations.add = function (this: any, value: unknown): any {
        const target = toRaw(this);
        const rawValue = toRaw(value);
        const hadKey = target.has(rawValue);
        target.add(rawValue);
        if (!hadKey) {
            // Trigger both the specific key and iteration
            const dep = depsMap.get(rawValue as string | symbol);
            if (dep) trigger(dep);
            const iterDep = depsMap.get(ITERATION_KEY);
            if (iterDep) trigger(iterDep);
            notify(rawValue as string | symbol);
        }
        return this; // Return the proxy, not raw
    };

    // set() - works on Map, WeakMap
    instrumentations.set = function (this: any, key: unknown, value: unknown): any {
        const target = toRaw(this);
        const rawKey = toRaw(key);
        const rawValue = toRaw(value);
        const hadKey = target.has(rawKey);
        const oldValue = target.get(rawKey);
        target.set(rawKey, rawValue);
        if (!hadKey) {
            // New key - trigger iteration
            const iterDep = depsMap.get(ITERATION_KEY);
            if (iterDep) trigger(iterDep);
        }
        if (!hadKey || !Object.is(oldValue, rawValue)) {
            // Value changed - trigger key dependency
            const dep = depsMap.get(rawKey as string | symbol);
            if (dep) trigger(dep);
            notify(rawKey as string | symbol);
        }
        return this; // Return the proxy, not raw
    };

    // delete() - works on Set, Map, WeakSet, WeakMap
    instrumentations.delete = function (this: any, key: unknown): boolean {
        const target = toRaw(this);
        const rawKey = toRaw(key);
        const hadKey = target.has(rawKey);
        const result = target.delete(rawKey);
        if (hadKey) {
            // Trigger both the specific key and iteration
            const dep = depsMap.get(rawKey as string | symbol);
            if (dep) trigger(dep);
            const iterDep = depsMap.get(ITERATION_KEY);
            if (iterDep) trigger(iterDep);
            notify(rawKey as string | symbol);
        }
        return result;
    };

    // clear() - works on Set, Map
    instrumentations.clear = function (this: any): void {
        const target = toRaw(this);
        const hadItems = target.size > 0;
        target.clear();
        if (hadItems) {
            // Trigger all dependencies
            for (const dep of depsMap.values()) {
                trigger(dep);
            }
            notify('clear');
        }
    };

    return instrumentations;
}

/**
 * Creates a reactive iterator that wraps values in reactive proxies.
 */
function createReactiveIterator(innerIterator: IterableIterator<any>, wrapValues: boolean): IterableIterator<any> {
    return {
        next() {
            const { value, done } = innerIterator.next();
            if (done) {
                return { value: undefined, done: true };
            }
            const wrappedValue = wrapValues && value && typeof value === 'object'
                ? (rawToReactive.get(value) || value)
                : value;
            return { value: wrappedValue, done: false };
        },
        [Symbol.iterator]() {
            return this;
        }
    };
}

/**
 * Creates a reactive entries iterator that wraps both keys and values.
 */
function createReactiveEntriesIterator(innerIterator: IterableIterator<[any, any]>): IterableIterator<[any, any]> {
    return {
        next() {
            const { value, done } = innerIterator.next();
            if (done) {
                return { value: undefined, done: true };
            }
            const [key, val] = value;
            const wrappedKey = key && typeof key === 'object' ? (rawToReactive.get(key) || key) : key;
            const wrappedVal = val && typeof val === 'object' ? (rawToReactive.get(val) || val) : val;
            return { value: [wrappedKey, wrappedVal] as [any, any], done: false };
        },
        [Symbol.iterator]() {
            return this;
        }
    };
}
