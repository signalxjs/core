// ============================================================================
// Signal - Reactive state primitives
// ============================================================================

import type { Dep, Signal, PrimitiveSignal, Primitive } from './types';
import { markSignal } from './signal-brand';
import { currentSubscriber, batch, startBatch, endBatch, createDep, track, trigger } from './effect';
import { getDevtoolsHook, registerReactiveProxy, notifySignalUpdated } from './devtools-hook';
import {
    isReactive,
    isCollection,
    isIterableCollection,
    shouldNotProxy,
    reactiveToRaw,
    rawToReactive,
    createCollectionInstrumentations,
    ITERATION_KEY,
    toRaw
} from './collections';

/**
 * WeakMap from a reactive proxy to its devtools id. Lets the `set`
 * trap emit `signal:updated` without each proxy carrying an extra
 * property. Only populated when a hook is installed at signal-create
 * time — production-without-devtools never grows this map.
 */
const signalIds = new WeakMap<object, number>();

/** Check if a value is a primitive type */
function isPrimitive(value: unknown): value is Primitive {
    if (value === null || value === undefined) return true;
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean' || type === 'symbol' || type === 'bigint';
}

let accessObserver: ((target: any, key: string | symbol) => void) | null = null;

/** @internal Get the current access observer for computed/model integration */
export function getAccessObserver(): ((target: any, key: string | symbol) => void) | null {
    return accessObserver;
}

/** @internal Temporarily suspend the access observer (used by computed to prevent leakage) */
export function setAccessObserver(observer: ((target: any, key: string | symbol) => void) | null): void {
    accessObserver = observer;
}

/**
 * Detect which reactive property a selector function accesses.
 *
 * Runs `selector()` while observing property accesses and returns the
 * last `[target, key]` pair accessed, or `null` if nothing was read.
 * Used internally by the model/two-way-binding system.
 *
 * @example
 * ```ts
 * const state = signal({ form: { name: 'Alice' } });
 * const result = detectAccess(() => state.form.name);
 * // result === [state.form, 'name']
 * ```
 */
export function detectAccess(selector: () => any): [any, string | symbol] | null {
    let result: [any, string | symbol] | null = null;
    const prev = accessObserver;

    // Capture the LAST access in the property chain
    // For nested paths like state.form.displayName, this gives [state.form, "displayName"]
    // Computed getters suspend the observer before evaluating, preventing leakage
    accessObserver = (target, key) => {
        result = [target, key];
    };

    try {
        selector();
    } finally {
        accessObserver = prev;
    }

    return result;
}

/**
 * Dev-only variant of {@link detectAccess} that also reports whether the
 * selector returned a value different from the last property it read.
 *
 * A valid model getter is a property-access chain whose return value IS the
 * leaf property (`() => state.a.b` returns `state.a.b`; a writable computed
 * `() => c.value` returns `c.value`). A transformed expression like
 * `() => transform(state.x)` or `() => state.count * 2` returns something
 * other than the property it read, which means a two-way binding would write
 * the transformed value back into that property — almost never the intent.
 *
 * @internal Used by the JSX runtime to warn in development.
 */
export function detectAccessDev(
    selector: () => any
): { access: [any, string | symbol] | null; looksTransformed: boolean } {
    let result: [any, string | symbol] | null = null;
    const prev = accessObserver;

    accessObserver = (target, key) => {
        result = [target, key];
    };

    let returnValue: any;
    try {
        returnValue = selector();
    } finally {
        accessObserver = prev;
    }

    // `as` resets control-flow narrowing — TS only sees the `= null` init, not
    // the assignment that happens inside the access-observer callback.
    const access = result as [any, string | symbol] | null;
    let looksTransformed = false;
    if (access && typeof access[1] === 'string') {
        const [obj, key] = access;
        // Object.is (not !==) so a getter that legitimately returns NaN — where
        // the bound property is also NaN — isn't flagged as transformed.
        looksTransformed = !Object.is((obj as Record<string, any>)[key], returnValue);
    }

    return { access, looksTransformed };
}

const arrayInstrumentations: Record<string, Function> = {};

// Mutator methods — batch to coalesce reactive triggers. Imperative
// startBatch/endBatch (in try/finally) instead of batch(fn): these run on
// every mutator call and must not allocate a closure or copy rest args.
['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(method => {
    const original = (Array.prototype as any)[method];
    arrayInstrumentations[method] = function (this: any) {
        startBatch();
        try {
            return original.apply(this, arguments);
        } finally {
            endBatch();
        }
    };
});

// Identity-based search methods — search against both raw and proxy values
// so that `reactiveArr.includes(rawObj)` works correctly
(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(method => {
    arrayInstrumentations[method] = function (this: any, ...args: any[]) {
        const raw = toRaw(this) as any[];
        // First try on the proxy (handles proxy-wrapped search values)
        const result = (Array.prototype as any)[method].apply(this, args);
        if (result !== -1 && result !== false) {
            return result;
        }
        // Fallback: search against the raw array (handles raw object search values)
        return (Array.prototype as any)[method].apply(raw, args);
    };
});

// Set lookup for the get trap: `hasOwnProperty` walks the prototype chain
// on every array property access; this is a single hash probe.
const arrayInstrumentedKeys = new Set(Object.keys(arrayInstrumentations));

// Overload for primitive types - wraps in { value: T }, no $set (use .value instead)
/**
 * Create a reactive signal from a value.
 *
 * For primitives, wraps the value as `{ value: T }` — access and mutate via `.value`.
 * For objects, returns a deeply reactive proxy with `.$set()` for full replacement.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * count.value++;
 *
 * const user = signal({ name: 'Alice' });
 * user.name = 'Bob'; // reactive
 * user.$set({ name: 'Carol' }); // replace entire object
 * ```
 */
export function signal<T extends Primitive>(target: T): PrimitiveSignal<T>;
// Overload for object types - includes $set for replacing the whole object
export function signal<T extends object>(target: T): Signal<T>;
// Implementation
export function signal<T>(target: T): PrimitiveSignal<T> | Signal<T & object> {
    // Handle primitive types by wrapping in { value: T }
    if (isPrimitive(target)) {
        return markSignal(signal({ value: target })) as unknown as PrimitiveSignal<T>;
    }

    const objectTarget = target as T & object;

    // Skip exotic built-ins that can't be proxied (Date, RegExp, etc.)
    // These have internal slots and will throw errors if proxied
    if (shouldNotProxy(objectTarget)) {
        return objectTarget as Signal<T & object>;
    }

    // Check if already reactive
    if (isReactive(objectTarget)) {
        return objectTarget as Signal<T & object>;
    }

    // Check if we already have a reactive version of this raw object
    const existingProxy = rawToReactive.get(objectTarget);
    if (existingProxy) {
        return existingProxy as Signal<T & object>;
    }

    // Defer depsMap allocation for non-collections (most signals).
    // Collections need the Map upfront for their write method instrumentations.
    const isCollectionTarget = isCollection(objectTarget);
    let depsMap: Map<string | symbol, Dep> | null = isCollectionTarget ? new Map() : null;
    // Lazy: most signals (primitives wrapped as { value }, flat objects)
    // never read a nested object, so don't pay a WeakMap per signal().
    let reactiveCache: WeakMap<object, any> | null = null;

    // DevTools id — only minted when a hook is currently installed.
    // The id stays on the proxy for the rest of its life via
    // `signalIds` so the `set` trap can include it in updates without
    // a per-write hook lookup.
    let signalId: number | null = null;
    if (__DEV__) {
        const hookAtCreate = getDevtoolsHook();
        if (hookAtCreate) {
            signalId = hookAtCreate.nextId();
            hookAtCreate.emit({
                type: 'signal:created',
                id: signalId,
                kind: isCollectionTarget ? 'collection' : 'object',
                ownerComponentId: hookAtCreate.currentOwner,
            });
        }
    }

    // Helper to get or create the dependency slot for a key
    const getOrCreateDep = (key: string | symbol): Dep => {
        if (!depsMap) depsMap = new Map();
        let dep = depsMap.get(key);
        if (!dep) {
            dep = createDep();
            depsMap.set(key, dep);
        }
        return dep;
    };

    // Create collection instrumentations if this is a collection.
    // The notify closure routes Map/Set mutations through the same
    // devtools emit path as plain object property writes. The proxy is
    // installed via setProxy right after construction below.
    const collectionSupport = isCollectionTarget
        ? createCollectionInstrumentations(objectTarget, depsMap!, getOrCreateDep, (key) => {
            notifySignalUpdated(signalId, key);
        })
        : null;
    const collectionInstrumentations = collectionSupport ? collectionSupport.instrumentations : null;

    // One $set closure per proxy, created on first read (was: a fresh
    // closure per $set access).
    let setFn: ((newValue: T & object) => void) | null = null;

    const proxy = new Proxy(objectTarget, {
        get(obj, prop, receiver) {
            if (prop === '$set') {
                return setFn ??= (newValue: T & object) => {
                    batch(() => {
                        if (Array.isArray(obj) && Array.isArray(newValue)) {
                            const len = newValue.length;
                            for (let i = 0; i < len; i++) {
                                Reflect.set(receiver, String(i), newValue[i]);
                            }
                            Reflect.set(receiver, 'length', len);
                        } else {
                            const newKeys = Object.keys(newValue);
                            const oldKeys = Object.keys(obj);
                            for (const key of newKeys) {
                                Reflect.set(receiver, key, (newValue as any)[key]);
                            }
                            for (const key of oldKeys) {
                                if (!(key in newValue)) {
                                    Reflect.deleteProperty(receiver, key);
                                }
                            }
                        }
                    });
                };
            }

            // Handle collection instrumentations (Set, Map, WeakSet, WeakMap)
            if (collectionInstrumentations) {
                // Special handling for 'size' getter
                if (prop === 'size' && isIterableCollection(obj)) {
                    if (currentSubscriber) track(getOrCreateDep(ITERATION_KEY));
                    return (obj as Set<any> | Map<any, any>).size;
                }
                
                // Instrumented methods close over the raw target and proxy,
                // so they are returned as-is — no per-access bind. Method
                // identity is stable (m.set === m.set).
                if (prop in collectionInstrumentations) {
                    return collectionInstrumentations[prop];
                }
            }

            if (Array.isArray(obj) && typeof prop === 'string' && arrayInstrumentedKeys.has(prop)) {
                return arrayInstrumentations[prop];
            }

            const value = Reflect.get(obj, prop);

            if (accessObserver) {
                accessObserver(receiver, prop);
            }

            // Track this property access (skip for collections - they use instrumentations)
            // Skip dep set allocation entirely when no effect is listening
            if (!collectionInstrumentations && currentSubscriber) {
                const dep = getOrCreateDep(prop);
                track(dep);
            }

            // If the value is an object, make it reactive too (with caching)
            // Skip exotic built-ins like Date, RegExp, etc. that have internal slots
            if (value && typeof value === 'object' && !shouldNotProxy(value)) {
                let cached = (reactiveCache ??= new WeakMap()).get(value);
                if (!cached) {
                    cached = signal(value);
                    reactiveCache.set(value, cached);
                }
                return cached;
            }

            return value;
        },
        set(obj, prop, newValue) {
            const oldLength = Array.isArray(obj) ? obj.length : 0;
            const oldValue = Reflect.get(obj, prop);
            const result = Reflect.set(obj, prop, newValue);

            // Only trigger if value actually changed
            if (!Object.is(oldValue, newValue)) {
                if (depsMap) {
                    // Array writes can hit several deps at once (an index
                    // plus `length`, or `length` plus truncated indices).
                    // Batch those so a subscriber of more than one runs
                    // once; the common single-dep write stays un-batched.
                    const isArray = Array.isArray(obj);
                    const lengthChanged = isArray && prop !== 'length' && obj.length !== oldLength;
                    const lengthShrunk = isArray && prop === 'length' &&
                        typeof newValue === 'number' && newValue < oldLength;

                    if (lengthChanged || lengthShrunk) {
                        startBatch();
                        try {
                            const dep = depsMap.get(prop);
                            if (dep) {
                                trigger(dep);
                            }
                            if (lengthChanged) {
                                const lengthDep = depsMap.get('length');
                                if (lengthDep) {
                                    trigger(lengthDep);
                                }
                            }
                            if (lengthShrunk) {
                                // Trigger indices that are now out of bounds
                                for (let i = newValue as number; i < oldLength; i++) {
                                    const idxDep = depsMap.get(String(i));
                                    if (idxDep) trigger(idxDep);
                                }
                            }
                        } finally {
                            endBatch();
                        }
                    } else {
                        const dep = depsMap.get(prop);
                        if (dep) {
                            trigger(dep);
                        }
                    }
                }

                // Devtools: emit on any actual state change, even if
                // nothing is currently subscribed (depsMap may be null
                // when nothing has read the signal yet). Centralized
                // via notifySignalUpdated so deleteProperty and the
                // collection instrumentations use the same path.
                notifySignalUpdated(signalId, prop);
            }

            return result;
        },
        deleteProperty(obj, prop) {
            const hasKey = Object.prototype.hasOwnProperty.call(obj, prop);
            const result = Reflect.deleteProperty(obj, prop);

            if (result && hasKey) {
                if (depsMap) {
                    const dep = depsMap.get(prop);
                    if (dep) {
                        trigger(dep);
                    }
                }
                // Devtools: a delete is also a state change — `$set()`
                // removals route through here too, so the panel needs
                // to see them.
                notifySignalUpdated(signalId, prop);
            }
            return result;
        }
    }) as Signal<T & object>;

    // Store the raw ↔ reactive mappings
    reactiveToRaw.set(proxy, objectTarget);
    rawToReactive.set(objectTarget, proxy);

    // Late-bind the proxy into the collection instrumentations (they are
    // built before the Proxy exists).
    if (collectionSupport) collectionSupport.setProxy(proxy);

    // Associate the proxy with its devtools id so consumers can look
    // it up later (e.g. when the panel asks for a signal's current
    // value). Only populated when a hook was installed at create time.
    if (signalId !== null) {
        signalIds.set(proxy, signalId);
        registerReactiveProxy(signalId, proxy);
    }

    return proxy;
}

/**
 * Get the devtools id of a reactive proxy, or `null` if it wasn't
 * created while a hook was installed. Used by `@sigx/devtools` to
 * map proxy values to their event ids.
 */
export function getSignalId(proxy: object): number | null {
    return signalIds.get(proxy) ?? null;
}
