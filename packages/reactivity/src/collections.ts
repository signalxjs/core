// ============================================================================
// Collection Reactivity Support (Set, Map, WeakSet, WeakMap)
// ============================================================================

import type { Dep } from './types';
import { startBatch, endBatch, track, trigger } from './effect';

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
    let raw = reactiveToRaw.get(observed as object);
    while (raw) {
        observed = raw as T;
        raw = reactiveToRaw.get(raw);
    }
    return observed;
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

// Built-ins with internal slots that should not be proxied (brand strings
// from Object.prototype.toString). Hoisted: shouldNotProxy runs on every
// object-valued property get and every signal() call.
const NON_PROXYABLE_BRANDS = new Set([
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
]);

// Per-prototype verdict cache for non-plain objects (Date.prototype -> true,
// MyClass.prototype -> false, ...). Keyed on the actual prototype object, so
// it is cross-realm-safe: each realm's built-in prototypes cache their own
// verdict via the brand check.
const protoVerdicts = new WeakMap<object, boolean>();

/**
 * Checks if a value is an "exotic" built-in object that should NOT be proxied.
 * These objects have internal slots that cannot be accessed through Proxy.
 * Proxying them causes errors like "Method X called on incompatible receiver".
 */
export function shouldNotProxy(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;

    // Fast path for the overwhelmingly common shapes: arrays and plain
    // objects are always proxyable — two pointer compares, no allocation.
    // Constructor-identity checks are deliberately NOT used as the primary
    // test (not cross-realm-safe); everything else resolves through the
    // brand check, cached per prototype.
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return false;

    // An own Symbol.toStringTag can spoof the brand per instance; genuine
    // built-ins never carry one. Bypass the cache for such values so one
    // spoofed instance can't poison the verdict for its whole prototype.
    if (Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)) {
        return NON_PROXYABLE_BRANDS.has(Object.prototype.toString.call(value));
    }

    let verdict = protoVerdicts.get(proto);
    if (verdict === undefined) {
        verdict = NON_PROXYABLE_BRANDS.has(Object.prototype.toString.call(value));
        protoVerdicts.set(proto, verdict);
    }
    return verdict;
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
    target: any,
    depsMap: Map<string | symbol, Dep>,
    getOrCreateDep: (key: string | symbol) => Dep,
    notify: (key: string | symbol) => void = () => {}
) {
    // The proxy doesn't exist yet when the instrumentations are built; the
    // caller installs it via setProxy right after constructing it. Methods
    // close over the raw target and the proxy instead of resolving
    // toRaw(this) per call and being re-bound per access.
    let proxy: any = null;
    const instrumentations: Record<string | symbol, any> = {};

    // ---- READ METHODS (track dependencies) ----

    // has() - works on Set, Map, WeakSet, WeakMap
    instrumentations.has = function (key: unknown): boolean {
        const rawKey = toRaw(key);
        track(getOrCreateDep(rawKey as string | symbol));
        return target.has(rawKey);
    };

    // get() - works on Map, WeakMap
    instrumentations.get = function (key: unknown): any {
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
        get() {
            track(getOrCreateDep(ITERATION_KEY));
            return target.size;
        }
    });

    // forEach() - works on Set, Map
    instrumentations.forEach = function (callback: Function, thisArg?: unknown): void {
        track(getOrCreateDep(ITERATION_KEY));
        target.forEach((value: any, key: any) => {
            // Make values reactive when iterating
            const reactiveValue = (value && typeof value === 'object')
                ? (rawToReactive.get(value) || value)
                : value;
            const reactiveKey = (key && typeof key === 'object')
                ? (rawToReactive.get(key) || key)
                : key;
            callback.call(thisArg, reactiveValue, reactiveKey, proxy);
        });
    };

    // keys() - works on Set, Map
    instrumentations.keys = function (): IterableIterator<any> {
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.keys();
        return createReactiveIterator(innerIterator, false);
    };

    // values() - works on Set, Map
    instrumentations.values = function (): IterableIterator<any> {
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.values();
        return createReactiveIterator(innerIterator, true);
    };

    // entries() - works on Set, Map
    instrumentations.entries = function (): IterableIterator<any> {
        track(getOrCreateDep(ITERATION_KEY));
        const innerIterator = target.entries();
        return createReactiveEntriesIterator(innerIterator);
    };

    // [Symbol.iterator] - works on Set, Map
    instrumentations[Symbol.iterator] = function (): IterableIterator<any> {
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
    instrumentations.add = function (value: unknown): any {
        const rawValue = toRaw(value);
        const hadKey = target.has(rawValue);
        target.add(rawValue);
        if (!hadKey) {
            // Trigger both the specific key and iteration as one flush so
            // an effect reading both runs once, not twice.
            startBatch();
            try {
                const dep = depsMap.get(rawValue as string | symbol);
                if (dep) trigger(dep);
                const iterDep = depsMap.get(ITERATION_KEY);
                if (iterDep) trigger(iterDep);
            } finally {
                endBatch();
            }
            notify(rawValue as string | symbol);
        }
        return proxy; // Return the proxy, not raw
    };

    // set() - works on Map, WeakMap
    instrumentations.set = function (key: unknown, value: unknown): any {
        const rawKey = toRaw(key);
        const rawValue = toRaw(value);
        const hadKey = target.has(rawKey);
        const oldValue = target.get(rawKey);
        target.set(rawKey, rawValue);
        if (!hadKey || !Object.is(oldValue, rawValue)) {
            // New key or changed value: trigger iteration (size/forEach)
            // and the key dependency as one flush.
            startBatch();
            try {
                if (!hadKey) {
                    const iterDep = depsMap.get(ITERATION_KEY);
                    if (iterDep) trigger(iterDep);
                }
                const dep = depsMap.get(rawKey as string | symbol);
                if (dep) trigger(dep);
            } finally {
                endBatch();
            }
            notify(rawKey as string | symbol);
        }
        return proxy; // Return the proxy, not raw
    };

    // delete() - works on Set, Map, WeakSet, WeakMap
    instrumentations.delete = function (key: unknown): boolean {
        const rawKey = toRaw(key);
        const hadKey = target.has(rawKey);
        const result = target.delete(rawKey);
        if (hadKey) {
            // Trigger both the specific key and iteration as one flush
            startBatch();
            try {
                const dep = depsMap.get(rawKey as string | symbol);
                if (dep) trigger(dep);
                const iterDep = depsMap.get(ITERATION_KEY);
                if (iterDep) trigger(iterDep);
            } finally {
                endBatch();
            }
            notify(rawKey as string | symbol);
        }
        return result;
    };

    // clear() - works on Set, Map
    instrumentations.clear = function (): void {
        const hadItems = target.size > 0;
        target.clear();
        if (hadItems) {
            // Trigger all dependencies as one flush
            startBatch();
            try {
                for (const dep of depsMap.values()) {
                    trigger(dep);
                }
            } finally {
                endBatch();
            }
            notify('clear');
        }
    };

    return {
        instrumentations,
        setProxy(p: any) { proxy = p; }
    };
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
