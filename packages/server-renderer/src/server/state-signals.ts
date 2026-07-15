/**
 * State-signal tracking and serialization — the strategy-agnostic capture side
 * of "named = transferred" (#257).
 *
 * A signal factory swapped in for `ctx.signal` during server setup records the
 * value of every NAMED signal so a strategy pack can ship it to the client.
 * The trailing `name` is NOT public component API — it is injected into
 * generated code by a pack's build transform, derived from the declaration
 * identifier (`const state = ctx.signal(…)` → key `"state"`). Keys are
 * namespaced per boundary record, so reuse across components is safe.
 *
 * Named = transferred: a signal without a key is plain local state — created,
 * never captured — and the client seeds it from the same initial. Any
 * server/client asymmetry therefore degrades to "not transferred", never to
 * restoring a wrong value. Duplicate keys within one boundary are first-wins:
 * later occurrences stay local so restoration can never mis-map values.
 *
 * Strategy packs re-export this pair rather than keeping their own copies;
 * the client counterpart lives in `../client/restore-signal`.
 */

import { signal } from 'sigx';
import { isSerializable } from './serialize';

/**
 * Signal factory used by components on the server to declare reactive state
 * whose value is captured for client transfer. Mirrors the `signal()` call
 * shape with an optional trailing `name` used as the serialization key.
 */
// Honest overloads (#263 review): only KEYED calls get the tracking/restoring
// proxy that uniformly exposes `{ value: T }` for primitives AND objects.
// Unkeyed and duplicate-key calls fall back to the plain core `signal()`,
// whose object form has NO `.value` — the type must not pretend otherwise.
export interface StateSignalFn {
    /** Keyed (transform-injected): the uniform `{ value: T }` proxy. */
    <T>(initial: T, name: string): { value: T };
    /**
     * Unkeyed: the plain core signal — primitives wrap as `{ value: T }`,
     * objects become a reactive proxy of the object's own shape (no `.value`).
     */
    <T>(initial: T): { value: T } | (T & object);
}

/**
 * Creates a tracking signal function that records signal keys and values.
 * Used during async setup to capture state for client transfer.
 * Supports both primitive and object signals.
 */
export function createTrackingSignal(signalMap: Map<string, any>): StateSignalFn {
    return function trackingSignal(initial: any, name?: string): any {
        // No key → local-only state: nothing to transfer under, so hand back a
        // plain signal and never capture it.
        if (!name) {
            return signal(initial as any);
        }

        // Duplicate key within one boundary (e.g. two declarations that
        // resolve to the same identifier via a shared setup helper): first
        // wins, later ones stay local so restoration can never mis-map values.
        if (signalMap.has(name)) {
            if (__DEV__) {
                console.warn(
                    `[sigx ssr] Duplicate state key "${name}" — two signals in the same ` +
                    `boundary resolve to the same declaration name. The first keeps the key; ` +
                    `this one stays local-only (not transferred). Declare each transferred ` +
                    `signal with a distinct variable name.`
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
    } as StateSignalFn;
}

/**
 * Serialize captured signal state for the boundary record. Serializability
 * checks route through the shared serializer discipline in `./serialize` —
 * one dev-warning path for every blob.
 */
export function serializeSignalState(signalMap: Map<string, any>): Record<string, any> | undefined {
    if (signalMap.size === 0) return undefined;

    const state: Record<string, any> = {};
    for (const [key, value] of signalMap) {
        if (isSerializable(key, value, 'state signal')) {
            state[key] = value;
        }
    }
    return Object.keys(state).length > 0 ? state : undefined;
}
