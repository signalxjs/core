// ============================================================================
// toSignal / toSignals - Per-property signal views over reactive objects
// ============================================================================

/**
 * A signal-shaped live view over a single property of a reactive object.
 * Reads and writes delegate to the source, so reactivity is preserved.
 */
export type PropertySignal<T> = { value: T };

/**
 * Property keys eligible for toSignal/toSignals: own enumerable string keys.
 * `$set` is excluded — it is the object-signal's replace method injected by
 * the proxy, not data, and Object.keys never enumerates it.
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
            source[key] = newValue;
        }
    };
}

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
export function toSignals<T extends object>(source: T): { [K in SignalKey<T>]-?: PropertySignal<T[K]> } {
    const result = {} as { [K in SignalKey<T>]-?: PropertySignal<T[K]> };
    for (const key of Object.keys(source) as SignalKey<T>[]) {
        result[key] = toSignal(source, key);
    }
    return result;
}
