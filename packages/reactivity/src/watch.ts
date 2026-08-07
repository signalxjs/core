// ============================================================================
// Watch - Reactive watchers with cleanup and options
// ============================================================================

import type { WatchSource, WatchCallback, WatchOptions, WatchHandle } from './types';
import { rawEffect, registerWithActiveScope } from './effect';
import { signal, trackAnyWrite } from './signal';
import { reactiveToRaw, shouldNotProxy } from './collections';

/**
 * Deeply subscribe the active effect to every object reachable from `value`.
 *
 * The whole traversal runs over RAW objects and touches the proxy exactly once
 * per object, to subscribe. Two measurements shaped it:
 *
 * - `Object.keys()` on a reactive proxy costs ~165x what it costs on the raw
 *   object (2036ns vs 12.3ns for a three-key object). V8 validates the
 *   `ownKeys` trap's result against the target's own property descriptors on
 *   every call — that is the proxy protocol, not the trap body, and on a
 *   200-row fixture it was ~68% of a deep-watch turn (#641).
 * - Reading each value back through the `get` trap to reach its per-key dep
 *   cost ~50ns a key, ~1200 keys, and produced ~1600 subscriptions where 402
 *   would do (#644).
 *
 * So neither happens now. `trackAnyWrite` subscribes to one dep covering every
 * write to an object — any key, new keys, deletions, Map/Set mutations — and
 * the recursion descends through the raw values, resolving each child's proxy
 * directly rather than by reading it out of its parent.
 *
 * The child proxy must still be MATERIALISED (not merely looked up): a write
 * always goes through a proxy, so an object we never proxied is an object whose
 * writes we would never see.
 *
 * Exported from `@sigx/reactivity/internals` as `deepTrack` (#651). `watch` is
 * not the only caller that needs a deep dirty signal, and the other one —
 * `@sigx/actors`, which parks the effect's re-run and folds it at a turn
 * boundary rather than re-walking per mutation — needs a `scheduler`, which
 * `WatchOptions` does not offer. Without a seam it carried a copy of this
 * function instead, and that copy sat on the pre-#642 algorithm while this one
 * moved twice: it enumerated the proxy AND read every key back. Exporting the
 * traversal rather than the `trackAnyWrite` leaf is deliberate — a caller given
 * only the leaf must re-derive `descend`, `shouldNotProxy` and the `signal()`
 * materialisation, all load-bearing and none of them exported, and would be
 * free to disagree with `watch(deep)` about what counts as a change all over
 * again.
 *
 * @param value The value to traverse. Subscribing needs a reactive proxy — a
 *   plain object has no deps to subscribe to, so passing one walks the shape
 *   and tracks nothing. That is what enumerating it used to do too.
 * @param depth Maximum depth (Infinity for unlimited, number for limited)
 * @param seen Raw objects already visited, to terminate on cycles
 * @internal
 */
export function traverse(value: unknown, depth: number = Infinity, seen: Set<unknown> = new Set()): unknown {
    if (depth <= 0) return value;
    if (value === null || typeof value !== 'object') return value;

    // `seen` holds RAW objects: the same object reached by two paths yields the
    // same proxy, but keying on raw is what makes that true by construction.
    const raw = (reactiveToRaw.get(value) ?? value) as object;
    if (seen.has(raw)) return value;
    seen.add(raw);

    // One subscription for the whole object. Fires for a changed key, a new
    // key, a deleted key, and — for collections — any mutation, which is why
    // Maps and Sets need nothing beyond this.
    trackAnyWrite(value);

    if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i++) {
            descend(raw[i], depth - 1, seen);
        }
    } else if (raw instanceof Map) {
        raw.forEach((v, k) => {
            descend(k, depth - 1, seen);
            descend(v, depth - 1, seen);
        });
    } else if (raw instanceof Set) {
        raw.forEach(v => {
            descend(v, depth - 1, seen);
        });
    } else {
        for (const key of Object.keys(raw)) {
            descend((raw as Record<string, unknown>)[key], depth - 1, seen);
        }
    }

    return value;
}

/**
 * Descend into a RAW child: give it a proxy so its writes are observable, then
 * traverse that.
 *
 * `signal()` is idempotent through the global raw→proxy map, so this is a
 * WeakMap hit for every object the traversal has seen before — cheaper than
 * reading the child out of its parent through the `get` trap, and it does not
 * subscribe to the parent's per-key dep as a side effect.
 *
 * Values `signal()` refuses to proxy (Date, RegExp, typed arrays — anything
 * with internal slots) are skipped before it is called: `signal()` hands such a
 * value straight back, so traversing the result would add a non-reactive object
 * to `seen` and enumerate keys that nothing can ever subscribe to.
 */
function descend(rawChild: unknown, depth: number, seen: Set<unknown>): void {
    if (depth <= 0 || rawChild === null || typeof rawChild !== 'object') return;
    if (shouldNotProxy(rawChild)) return;
    traverse(signal(rawChild as object), depth, seen);
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
