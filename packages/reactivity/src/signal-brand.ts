// ============================================================================
// Signal brand - identity registry for signal-shaped { value } handles
// ============================================================================
// Deliberately dependency-free: both signal.ts and toSignal.ts brand their
// handles here, and consumers that only import isSignal/toSignal must not
// pull the full signal implementation into their bundle.

/**
 * Brand registry for signal-shaped `{ value }` handles: primitive-wrapper
 * signals (`signal(0)`) and `toSignal`/`toSignals` property views. Powers
 * {@link isSignal}. Object signals are NOT branded — test those with
 * `isReactive()`; computeds with `isComputed()`.
 */
const valueSignals = new WeakSet<object>();

/** @internal Brand a `{ value }` handle so isSignal() recognizes it. */
export function markSignal<T extends object>(handle: T): T {
    valueSignals.add(handle);
    return handle;
}

/**
 * Check whether a value is a signal-shaped `{ value }` handle: a
 * primitive-wrapper signal created by `signal(primitive)`, or a property
 * view from `toSignal`/`toSignals`.
 *
 * Returns `false` for object signals (use `isReactive`) and computeds
 * (use `isComputed`).
 *
 * @example
 * ```ts
 * isSignal(signal(0));            // true
 * isSignal(toSignal(state, 'x')); // true
 * isSignal(signal({ x: 1 }));     // false — object signal
 * isSignal({ value: 1 });         // false — plain object
 * ```
 */
export function isSignal(value: unknown): value is { value: unknown } {
    return typeof value === 'object' && value !== null && valueSignals.has(value);
}
