// ============================================================================
// Computed Signals - Lazy, cached, reactive derived values
// ============================================================================

import type { 
    Subscriber, 
    Computed, 
    WritableComputed, 
    ComputedGetter, 
    ComputedSetter, 
    WritableComputedOptions 
} from './types';
import { ComputedSymbol } from './types';
import { cleanup, track, trigger, setCurrentSubscriber, getCurrentSubscriber } from './effect';
import { getAccessObserver, setAccessObserver } from './signal';
import { getDevtoolsHook, registerReactiveProxy } from './devtools-hook';

/**
 * Creates a computed signal that lazily derives a value from other reactive sources.
 * 
 * Performance characteristics:
 * - Lazy: Only computes when accessed
 * - Cached: Returns cached value if dependencies haven't changed
 * - Minimal overhead: Uses dirty flag instead of always running getter
 * 
 * @example
 * ```ts
 * const count = signal({ n: 0 });
 * const doubled = computed(() => count.n * 2);
 * 
 * console.log(doubled.value);  // 0
 * count.n = 5;
 * console.log(doubled.value);  // 10
 * ```
 */
export function computed<T>(getter: ComputedGetter<T>): Computed<T>;
export function computed<T>(options: WritableComputedOptions<T>): WritableComputed<T>;
export function computed<T>(
    getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
): Computed<T> | WritableComputed<T> {
    let getter: ComputedGetter<T>;
    let setter: ComputedSetter<T> | undefined;

    if (typeof getterOrOptions === 'function') {
        getter = getterOrOptions;
    } else {
        getter = getterOrOptions.get;
        setter = getterOrOptions.set;
    }

    const subscribers = new Set<Subscriber>();
    let cachedValue: T;
    let dirty = true;

    // Devtools id minted at create time. `null` skips emissions
    // entirely on every recompute.
    const hookAtCreate = getDevtoolsHook();
    const computedId: number | null = hookAtCreate ? hookAtCreate.nextId() : null;
    if (hookAtCreate && computedId !== null) {
        hookAtCreate.emit({
            type: 'computed:created',
            id: computedId,
            ownerComponentId: hookAtCreate.currentOwner,
        });
    }

    // Internal effect for dependency tracking
    const computedEffect: Subscriber = function () {
        if (!dirty) {
            dirty = true;
            trigger(subscribers);
        }
    } as Subscriber;
    computedEffect.deps = [];

    const computeValue = (): T => {
        cleanup(computedEffect);
        const prevEffect = getCurrentSubscriber();
        setCurrentSubscriber(computedEffect);
        try {
            cachedValue = getter();
            dirty = false;
            if (computedId !== null) {
                const hook = getDevtoolsHook();
                if (hook) hook.emit({ type: 'computed:recomputed', id: computedId });
            }
            return cachedValue;
        } finally {
            setCurrentSubscriber(prevEffect);
        }
    };

    // The computed object with .value accessor
    const computedObj = {
        [ComputedSymbol]: true as const,
        get value(): T {
            // Notify access observer for model binding integration (detectAccess)
            const observer = getAccessObserver();
            if (observer) {
                observer(computedObj, 'value');
                // Suspend observer so computeValue's internal signal reads don't leak
                setAccessObserver(null);
            }
            track(subscribers);
            const result = dirty ? computeValue() : cachedValue;
            // Restore observer after compute
            if (observer) setAccessObserver(observer);
            return result;
        },
    };

    // Add setter if provided (writable computed)
    if (setter) {
        Object.defineProperty(computedObj, 'value', {
            get(): T {
                // Notify access observer for model binding integration (detectAccess)
                const observer = getAccessObserver();
                if (observer) {
                    observer(computedObj, 'value');
                    // Suspend observer so computeValue's internal signal reads don't leak
                    setAccessObserver(null);
                }
                track(subscribers);
                const result = dirty ? computeValue() : cachedValue;
                // Restore observer after compute
                if (observer) setAccessObserver(observer);
                return result;
            },
            set(newValue: T) {
                setter!(newValue);
            },
            enumerable: true,
            configurable: false,
        });
        if (computedId !== null) registerReactiveProxy(computedId, computedObj);
        return computedObj as WritableComputed<T>;
    }

    if (computedId !== null) registerReactiveProxy(computedId, computedObj);
    return computedObj as Computed<T>;
}

/**
 * Type guard to check if a value is a computed signal.
 * 
 * @example
 * ```ts
 * const doubled = computed(() => count.value * 2);
 * console.log(isComputed(doubled)); // true
 * console.log(isComputed({ value: 1 })); // false
 * ```
 */
export function isComputed(value: unknown): value is Computed<unknown> {
    return value !== null && typeof value === 'object' && ComputedSymbol in value;
}
