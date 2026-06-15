/**
 * Component rendering utilities for SSR islands
 *
 * Signal tracking and state serialization for hydration state transfer.
 * Moved from @sigx/server-renderer — this is island-specific overhead.
 */

import {
    signal
} from 'sigx';

/**
 * Signal factory used by island components on the server to declare reactive
 * state whose value is captured for client hydration. Mirrors the `signal()`
 * call shape with an optional stable `name` used as the serialization key.
 *
 * This is island-specific overhead — it used to live in `@sigx/server-renderer`
 * but was removed when the SSR layer moved to the `useAsync`/`useStream` +
 * `__SIGX_ASYNC__` state model. Islands keeps its own copy.
 */
// The tracking signal deliberately normalizes to a uniform `{ value: T }`
// interface (its Proxy intercepts `.value` for primitives AND objects), unlike
// raw `signal()` whose object form exposes no `.value`. This shape is what island
// component code reads, so it is the correct type here — do not "narrow" it to
// `ReturnType<typeof signal>`.
export type SSRSignalFn = <T>(initial: T, name?: string) => { value: T };

/**
 * Generate a stable serialization key for a tracked island signal. Named
 * signals key by their name; unnamed signals fall back to a positional
 * `$<index>` key (fragile across server/client declaration-order drift —
 * `createTrackingSignal` warns in dev).
 *
 * Private helper — previously exported by `@sigx/server-renderer`, now local.
 */
function generateSignalKey(name: string | undefined, index: number): string {
    return name ?? `$${index}`;
}

/**
 * Creates a tracking signal function that records signal names and values.
 * Used during async setup to capture state for client hydration.
 * Supports both primitive and object signals.
 */
export function createTrackingSignal(signalMap: Map<string, any>): SSRSignalFn {
    let signalIndex = 0;
    let hasWarnedPositional = false;

    return function trackingSignal(initial: any, name?: string): any {
        // Generate a stable key for this signal
        const key = generateSignalKey(name, signalIndex++);

        // Dev warning: positional keys are fragile in islands
        if (process.env.NODE_ENV !== 'production' && !name && !hasWarnedPositional) {
            hasWarnedPositional = true;
            // Guard the hint: `initial` may hold circular references, and an
            // unguarded JSON.stringify here would throw and break SSR in dev.
            let initialHint: string;
            try {
                initialHint = JSON.stringify(initial);
            } catch {
                initialHint = String(initial);
            }
            console.warn(
                `[SSR Islands] Signal created without a name in an island component. ` +
                `Positional keys ("${key}") are fragile — if signal declaration order differs ` +
                `between server and client, state restoration will silently restore wrong values. ` +
                `Consider using named signals: signal(${initialHint}, "mySignalName")`
            );
        }

        // Create the real signal (handles both primitives and objects)
        const sig = signal(initial as any);

        // Capture initial value
        signalMap.set(key, initial);

        // Create a proxy that tracks writes to .value
        const proxy = new Proxy(sig as any, {
            get(target: any, prop: string | symbol) {
                if (prop === 'value') {
                    return target.value;
                }
                return target[prop];
            },
            set(target: any, prop: string | symbol, newValue: any) {
                if (prop === 'value') {
                    target.value = newValue;
                    signalMap.set(key, newValue);
                    return true;
                }
                target[prop] = newValue;
                return true;
            }
        });

        return proxy;
    } as SSRSignalFn;
}

/**
 * Serialize captured signal state for client hydration
 */
export function serializeSignalState(signalMap: Map<string, any>): Record<string, any> | undefined {
    if (signalMap.size === 0) return undefined;

    const state: Record<string, any> = {};
    for (const [key, value] of signalMap) {
        try {
            // Test if serializable
            JSON.stringify(value);
            state[key] = value;
        } catch {
            // Skip non-serializable values
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`SSR: Signal "${key}" has non-serializable value, skipping`);
            }
        }
    }
    return Object.keys(state).length > 0 ? state : undefined;
}
