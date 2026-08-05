// ============================================================================
// Watch - Reactive watchers with cleanup and options
// ============================================================================

import type { WatchSource, WatchCallback, WatchOptions, WatchHandle } from './types';
import { rawEffect, registerWithActiveScope } from './effect';
import { trackKeySet } from './signal';
import { reactiveToRaw } from './collections';

/**
 * Deeply traverses an object to trigger reactive tracking on all nested properties.
 * @param value The value to traverse
 * @param depth Maximum depth to traverse (Infinity for unlimited, number for limited)
 * @param seen Set of already visited objects to prevent circular references
 */
function traverse(value: unknown, depth: number = Infinity, seen: Set<unknown> = new Set()): unknown {
    // Don't traverse primitives, null, or if we've exceeded depth
    if (depth <= 0) return value;
    if (value === null || typeof value !== 'object') return value;
    
    // Prevent circular references
    if (seen.has(value)) return value;
    seen.add(value);
    
    if (Array.isArray(value)) {
        // Traverse array elements
        for (let i = 0; i < value.length; i++) {
            traverse(value[i], depth - 1, seen);
        }
    } else if (value instanceof Map) {
        // Traverse Map entries
        value.forEach((v, k) => {
            traverse(k, depth - 1, seen);
            traverse(v, depth - 1, seen);
        });
    } else if (value instanceof Set) {
        // Traverse Set values
        value.forEach(v => {
            traverse(v, depth - 1, seen);
        });
    } else {
        // Enumerate the RAW target, read back through the proxy.
        //
        // `Object.keys()` on a reactive proxy costs ~165x what it costs on the
        // raw object — 2036ns vs 12.3ns for a three-key object — because V8
        // validates the `ownKeys` trap's result against the target's own
        // property descriptors on every call. That is not the trap body (which
        // profiles separately at ~11%); it is the proxy protocol itself, and on
        // a 200-row fixture it was ~68% of an entire deep-watch turn (#641).
        // It scales with the number of plain OBJECTS walked, not with keys,
        // which is why arrays — handled by the index loop above — never paid it.
        //
        // The key set is identical either way: the `ownKeys` trap returns
        // `Reflect.ownKeys(target)`, so `Object.keys` over the proxy and over
        // the raw target enumerate exactly the same own enumerable string keys.
        // Reading each one back through the proxy still subscribes per key and
        // still materialises the nested proxy the recursion needs.
        //
        // `trackKeySet` replaces the ONE thing enumerating the proxy did that
        // reading keys does not: subscribing to the key-set dep, without which
        // a new key added to this object would never notify.
        const raw = reactiveToRaw.get(value) ?? value;
        trackKeySet(value);
        for (const key of Object.keys(raw)) {
            traverse((value as Record<string, unknown>)[key], depth - 1, seen);
        }
    }
    
    return value;
}

/**
 * Watch a reactive source and run a callback when it changes.
 * Supports deep watching, immediate invocation, and pause/resume.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const handle = watch(() => count.value, (newVal, oldVal) => {
 *   console.log(`${oldVal} → ${newVal}`);
 * });
 * handle.stop(); // stop watching
 * ```
 */
export function watch<T>(source: WatchSource<T>, cb: WatchCallback<T>, options?: WatchOptions): WatchHandle {
    let oldValue: T | undefined;
    let isFirst = true;
    let cleanupFn: (() => void) | null = null;
    let paused = false;
    let pendingValue: T | undefined;
    let hasPending = false;
    let stopped = false;

    // Determine traverse depth from deep option
    const deep = options?.deep;
    const traverseDepth = deep === true ? Infinity : (typeof deep === 'number' ? deep : 0);

    // rawEffect: the scope must dispose the WHOLE watcher (including the
    // user's onCleanup teardown), so the full handle is registered below
    // instead of the bare effect runner.
    const runner = rawEffect(() => {
        if (stopped) return;
        
        let newValue = typeof source === 'function' ? (source as () => T)() : source;
        
        // If deep watching, traverse the value to track nested properties
        if (traverseDepth > 0) {
            traverse(newValue, traverseDepth);
        }

        if (paused) {
            // Store pending value to process on resume
            pendingValue = newValue;
            hasPending = true;
            return;
        }

        if (isFirst) {
            if (options?.immediate) {
                if (cleanupFn) cleanupFn();
                cb(newValue, oldValue, (fn) => cleanupFn = fn);
                // If once option, stop after immediate callback
                if (options?.once) {
                    stopped = true;
                    // Schedule stop for next tick to allow effect to complete
                    queueMicrotask(() => stop());
                }
            }
            isFirst = false;
        } else {
            if (cleanupFn) cleanupFn();
            cb(newValue, oldValue, (fn) => cleanupFn = fn);
            // If once option, stop after first callback
            if (options?.once) {
                stopped = true;
                // Schedule stop for next tick to allow effect to complete
                queueMicrotask(() => stop());
            }
        }
        oldValue = newValue;
    });

    let disposed = false;
    const stop = () => {
        if (disposed) return;
        disposed = true;
        stopped = true;
        // Clear pause/pending state so a resume() after stop() can never
        // run the callback with a stale pending value.
        paused = false;
        hasPending = false;
        pendingValue = undefined;
        runner.stop();
        if (cleanupFn) {
            cleanupFn();
            cleanupFn = null;
        }
    };

    registerWithActiveScope(stop);

    const pause = () => {
        paused = true;
    };

    const resume = () => {
        if (!paused) return;
        paused = false;
        // If value changed while paused, trigger callback now
        if (hasPending && !Object.is(pendingValue, oldValue)) {
            if (cleanupFn) cleanupFn();
            cb(pendingValue as T, oldValue, (fn) => cleanupFn = fn);
            oldValue = pendingValue;
        }
        hasPending = false;
        pendingValue = undefined;
    };

    return Object.assign(stop, { stop, pause, resume });
}
