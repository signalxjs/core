// ============================================================================
// toSignal / toSignals - Per-property signal views over reactive objects
// ============================================================================

/**
 * A signal-shaped live view over a single property of a reactive object.
 * Reads and writes delegate to the source, so reactivity is preserved.
 */
export type PropertySignal<T> = { value: T };

/**
 * Property keys eligible for toSignal/toSignals: string keys excluding
 * `$set` (the object-signal's replace method injected by the proxy — not
 * data). Note that `toSignals()` additionally only creates views for keys
 * `Object.keys` yields at runtime (own enumerable keys).
 */
type SignalKey<T> = Exclude<Extract<keyof T, string>, '$set'>;

/**
 * Create a signal-shaped view over one property of a reactive object.
 * Unlike destructuring (which snapshots the value), the returned object
 * reads and writes through to the source, so tracking and triggering work.
 *
 * @example
 * ```ts
 * const state = signal({ count: 0 });
 * const count = toSignal(state, 'count');
 * count.value++;        // triggers effects watching state.count
 * ```
 */
export function toSignal<T extends object, K extends SignalKey<T>>(source: T, key: K): PropertySignal<T[K]> {
    return {
        get value() {
            return source[key];
        },
        set value(newValue: T[K]) {
            // Reflect.set reports rejected writes (read-only descriptors,
            // proxies that refuse the set) instead of a generic TypeError.
            if (!Reflect.set(source, key, newValue)) {
                throw new Error(`[sigx] toSignal: cannot write to read-only property "${String(key)}".`);
            }
        }
    };
}

/**
 * Per-key views of a reactive object. The homomorphic key-remapped map
 * preserves optional property markers from T; at runtime, views exist only
 * for keys Object.keys yields (own enumerable string keys).
 */
export type ToSignals<T extends object> = {
    [K in keyof T as K extends SignalKey<T> ? K : never]: PropertySignal<T[K]>;
};

/**
 * Create signal-shaped views for every own enumerable property of a reactive
 * object, so it can be destructured without losing reactivity.
 *
 * @example
 * ```ts
 * const state = signal({ count: 0, name: 'Ada' });
 * const { count, name } = toSignals(state);
 * count.value++;        // still reactive
 * ```
 */
export function toSignals<T extends object>(source: T): ToSignals<T> {
    const result = {} as ToSignals<T>;
    for (const key of Object.keys(source)) {
        // Match the type-level contract at runtime: user data may contain an
        // own enumerable "$set" key, which must not get a view (the proxy get
        // trap would serve the injected replacer instead of the data).
        if (key === '$set') continue;
        (result as Record<string, PropertySignal<unknown>>)[key] =
            toSignal(source, key as SignalKey<T>) as PropertySignal<unknown>;
    }
    return result;
}
