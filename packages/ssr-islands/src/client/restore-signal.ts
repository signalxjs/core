/**
 * Client-side signal restoration for SSR islands.
 *
 * Counterpart to the server's `createTrackingSignal` (`server/render-component.ts`):
 * during hydration an island's `ctx.signal` is swapped for this variant so each
 * declared signal is seeded from the server-captured state instead of its literal
 * initial value. The signal then behaves as a normal live signal — writes drive
 * client reactivity; there is no write-back map.
 */

import { signal } from 'sigx';
import type { SSRSignalFn } from '../server/render-component';

/**
 * Create a signal factory that seeds island signals from server-captured state.
 *
 * Must mirror `createTrackingSignal`'s keying: the key is the trailing `name`
 * injected by the `sigxIslands()` Vite transform (never public component API);
 * a signal without a key is plain local state and seeds from its own initial.
 * Duplicate keys follow the server's first-wins rule — the first occurrence
 * restores, later ones stay local — so the two sides can never mis-map values.
 *
 * Named signals keep `createTrackingSignal`'s shape — a `{ value }` proxy that
 * uniformly exposes `.value` for both primitive and object signals — so island
 * component code reads the same interface on the client as it produced on the
 * server. When the key is present in `state`, the signal starts from the
 * restored value; otherwise it falls back to the supplied `initial`.
 */
export function createRestoringSignal(state: Record<string, any>): SSRSignalFn {
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
                    `[SSR Islands] Duplicate island state key "${name}" — two signals in the same ` +
                    `island resolve to the same declaration name. The first keeps the key; this one ` +
                    `stays local-only (not restored). Declare each transferred signal with a ` +
                    `distinct variable name.`
                );
            }
            return signal(initial as any);
        }
        seen.add(name);

        const key = name;
        const seed = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : initial;

        // Live signal — writes go straight through so client reactivity works.
        const sig = signal(seed as any);

        return new Proxy(sig as any, {
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
    } as SSRSignalFn;
}
