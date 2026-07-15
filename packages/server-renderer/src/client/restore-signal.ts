/**
 * Client-side signal restoration — the restore side of "named = transferred"
 * (#257), counterpart to the server's `createTrackingSignal`
 * (`../server/state-signals`).
 *
 * During hydration/upgrade a strategy pack swaps a component's `ctx.signal`
 * for this variant so each declared signal is seeded from the server-captured
 * state instead of its literal initial value. The signal then behaves as a
 * normal live signal — writes drive client reactivity; there is no write-back
 * map.
 */

import { signal } from 'sigx';
import type { StateSignalFn } from '../server/state-signals';

/**
 * Create a signal factory that seeds signals from server-captured state.
 *
 * Must mirror `createTrackingSignal`'s keying: the key is the trailing `name`
 * injected by a pack's build transform (never public component API); a signal
 * without a key is plain local state and seeds from its own initial.
 * Duplicate keys follow the server's first-wins rule — the first occurrence
 * restores, later ones stay local — so the two sides can never mis-map values.
 *
 * Named signals keep `createTrackingSignal`'s shape — a `{ value }` proxy that
 * uniformly exposes `.value` for both primitive and object signals — so
 * component code reads the same interface on the client as it produced on the
 * server. When the key is present in `state`, the signal starts from the
 * restored value; otherwise it falls back to the supplied `initial`.
 *
 * The optional `report` callback is invoked once per NAMED, non-duplicate
 * signal with its key and live `{ value }` proxy — packs use it to re-point
 * external facades at the freshly created signals.
 */
export function createRestoringSignal(
    state: Record<string, any>,
    // The reported live signal is always the wrapper proxy, which intercepts
    // `.value` for primitives AND objects — though for the object form the
    // property starts undefined until first written (the object's own
    // reactive fields carry the state). Hence `unknown`, not a lie-free
    // primitive type.
    report?: ((name: string, live: { value: unknown }) => void) | null
): StateSignalFn {
    const seen = new Set<string>();

    return function restoringSignal(initial: any, name?: string): any {
        // No key → local-only state, exactly as on the server.
        if (!name) {
            return signal(initial as any);
        }

        // Duplicate key → local-only, matching the server's first-wins rule.
        if (seen.has(name)) {
            if (__DEV__) {
                console.warn(
                    `[sigx ssr] Duplicate state key "${name}" — two signals in the same ` +
                    `boundary resolve to the same declaration name. The first keeps the key; ` +
                    `this one stays local-only (not restored). Declare each transferred ` +
                    `signal with a distinct variable name.`
                );
            }
            return signal(initial as any);
        }
        seen.add(name);

        const seed = Object.prototype.hasOwnProperty.call(state, name) ? state[name] : initial;

        // Live signal — writes go straight through so client reactivity works.
        const sig = signal(seed as any);

        // Uniform `{ value }` shape for primitives AND objects — the same
        // interface the tracking signal produced on the server.
        const live = new Proxy(sig as any, {
            get(target: any, prop: string | symbol, receiver: any) {
                if (prop === 'value') {
                    return target.value;
                }
                // Preserve receiver semantics for getters / signal methods.
                return Reflect.get(target, prop, receiver);
            },
            set(target: any, prop: string | symbol, newValue: any, receiver: any) {
                if (prop === 'value') {
                    target.value = newValue;
                    return true;
                }
                return Reflect.set(target, prop, newValue, receiver);
            }
        });

        report?.(name, live);
        return live;
    } as StateSignalFn;
}
