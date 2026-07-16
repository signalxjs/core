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
import {
    startTracking,
    endTracking,
    createDep,
    track,
    setCurrentSubscriber,
    getCurrentSubscriber,
    sourcesChanged,
    CLEAN,
    DIRTY,
    MAYBE_DIRTY,
    COMPUTING,
    ERRORED,
} from './effect';
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

    const ownDep = createDep();
    let cachedValue: T;
    let firstRun = true;

    // Devtools id minted at create time. `null` skips emissions
    // entirely on every recompute.
    let computedId: number | null = null;
    if (__DEV__) {
        const hookAtCreate = getDevtoolsHook();
        if (hookAtCreate) {
            computedId = hookAtCreate.nextId();
            hookAtCreate.emit({
                type: 'computed:created',
                id: computedId,
                ownerComponentId: hookAtCreate.currentOwner,
            });
        }
    }

    // Internal subscriber node. Its function body is never invoked: the
    // mark phase flags computed nodes and recurses into their own dep
    // instead of calling them; recomputation happens lazily in refresh().
    const computedEffect: Subscriber = function () {
    } as Subscriber;
    computedEffect.deps = [];
    computedEffect.flags = DIRTY; // must compute on first read
    computedEffect.ownDep = ownDep;
    ownDep.computed = computedEffect;

    /**
     * Pull phase: bring the cached value up to date.
     * - CLEAN: nothing to do.
     * - MAYBE_DIRTY only: validate sources first; if none actually
     *   changed value, become CLEAN without running the getter (cutoff).
     * - DIRTY (or validation found a change): recompute, and advance
     *   ownDep.version only if the result is not Object.is-equal — the
     *   value-equality cutoff downstream subscribers validate against.
     */
    const refresh = (): void => {
        const flags = computedEffect.flags;
        if ((flags & COMPUTING) !== 0) return; // cycle: yield cached value
        if ((flags & (DIRTY | MAYBE_DIRTY)) === 0) return;
        if ((flags & DIRTY) === 0) {
            if (!sourcesChanged(computedEffect)) {
                computedEffect.flags = CLEAN;
                return;
            }
        }
        computedEffect.flags = COMPUTING;
        startTracking(computedEffect);
        const prevEffect = getCurrentSubscriber();
        setCurrentSubscriber(computedEffect);
        try {
            const newValue = getter();
            const changed = firstRun || !Object.is(newValue, cachedValue);
            cachedValue = newValue;
            firstRun = false;
            computedEffect.flags = CLEAN;
            if (changed) ownDep.version++;
            if (__DEV__ && computedId !== null) {
                const hook = getDevtoolsHook();
                if (hook) hook.emit({ type: 'computed:recomputed', id: computedId });
            }
        } catch (err) {
            // Surface getter errors at read time and retry on the next
            // read. ERRORED forces downstream re-notification on the next
            // source write, so subscribed effects aren't wedged by a
            // transient failure.
            computedEffect.flags = DIRTY | ERRORED;
            throw err;
        } finally {
            // A throwing getter keeps only the deps read before the throw —
            // the same resulting dep set as the old cleanup-up-front flow.
            endTracking(computedEffect);
            setCurrentSubscriber(prevEffect);
        }
    };
    computedEffect.refresh = refresh;

    const readValue = (): T => {
        // Notify access observer for model binding integration (detectAccess)
        const observer = getAccessObserver();
        if (observer) {
            observer(computedObj, 'value');
            // Suspend observer so refresh's internal signal reads don't leak
            setAccessObserver(null);
        }
        try {
            refresh();
        } finally {
            // Track AFTER refresh so the link records the post-recompute
            // version; in a finally so a throwing getter still subscribes
            // the reader for the retry.
            track(ownDep);
            // Restore observer after compute
            if (observer) setAccessObserver(observer);
        }
        return cachedValue;
    };

    // The computed object with .value accessor
    const computedObj = {
        [ComputedSymbol]: true as const,
        get value(): T {
            return readValue();
        },
    };

    // Add setter if provided (writable computed)
    if (setter) {
        Object.defineProperty(computedObj, 'value', {
            get(): T {
                return readValue();
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
