// ============================================================================
// Watch - Reactive watchers with cleanup and options
// ============================================================================

import type { WatchSource, WatchCallback, WatchOptions, WatchHandle } from './types';
import { effect } from './effect';

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
        // Traverse object properties
        for (const key of Object.keys(value)) {
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

    const runner = effect(() => {
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

    const stop = () => {
        stopped = true;
        runner.stop();
        if (cleanupFn) cleanupFn();
    };

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
