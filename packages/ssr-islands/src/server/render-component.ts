/**
 * Component rendering utilities for SSR islands
 *
 * Signal tracking and state serialization for hydration state transfer.
 * Moved from @sigx/server-renderer — this is island-specific overhead.
 */

import {
    signal
} from 'sigx';
import { isSerializable } from '@sigx/server-renderer/server';

/**
 * Signal factory used by island components on the server to declare reactive
 * state whose value is captured for client hydration. Mirrors the `signal()`
 * call shape with an optional trailing `name` used as the serialization key.
 *
 * The `name` is NOT public component API — it is injected into generated code
 * by the `sigxIslands()` Vite transform, which derives it from the declaration
 * identifier (`const state = ctx.signal(…)` → key `"state"`). Keys are
 * namespaced per island boundary record, so reuse across components is safe.
 *
 * Named = transferred: a signal without a key is plain local state — created,
 * never captured — and the client seeds it from the same initial. Any
 * server/client asymmetry therefore degrades to "not transferred", never to
 * restoring a wrong value.
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
 * Creates a tracking signal function that records signal keys and values.
 * Used during async setup to capture state for client hydration.
 * Supports both primitive and object signals.
 */
export function createTrackingSignal(signalMap: Map<string, any>): SSRSignalFn {
    return function trackingSignal(initial: any, name?: string): any {
        // No key → local-only state: nothing to transfer under, so hand back a
        // plain signal and never capture it.
        if (!name) {
            return signal(initial as any);
        }

        // Duplicate key within one island (e.g. two declarations that resolve
        // to the same identifier via a shared setup helper): first wins, later
        // ones stay local so restoration can never mis-map values.
        if (signalMap.has(name)) {
            if (__DEV__) {
                console.warn(
                    `[SSR Islands] Duplicate island state key "${name}" — two signals in the same ` +
                    `island resolve to the same declaration name. The first keeps the key; this one ` +
                    `stays local-only (not transferred). Declare each transferred signal with a ` +
                    `distinct variable name.`
                );
            }
            return signal(initial as any);
        }

        const key = name;

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
 * Serialize captured signal state for client hydration. Serializability
 * checks route through the shared serializer discipline in
 * `@sigx/server-renderer` — one dev-warning path for every blob.
 */
export function serializeSignalState(signalMap: Map<string, any>): Record<string, any> | undefined {
    if (signalMap.size === 0) return undefined;

    const state: Record<string, any> = {};
    for (const [key, value] of signalMap) {
        if (isSerializable(key, value, 'island signal')) {
            state[key] = value;
        }
    }
    return Object.keys(state).length > 0 ? state : undefined;
}
