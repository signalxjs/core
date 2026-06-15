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
 * Generate the serialization key for a restored island signal. Must match
 * `generateSignalKey` in `server/render-component.ts`: named signals key by their
 * name, unnamed signals fall back to a positional `$<index>` key.
 */
function generateSignalKey(name: string | undefined, index: number): string {
    return name ?? `$${index}`;
}

/**
 * Create a signal factory that seeds island signals from server-captured state.
 *
 * Mirrors `createTrackingSignal`'s shape — a `{ value }` proxy that uniformly
 * exposes `.value` for both primitive and object signals — so island component
 * code reads the same interface on the client as it produced on the server. When
 * the serialization key is present in `state`, the signal starts from the restored
 * value; otherwise it falls back to the supplied `initial`.
 */
export function createRestoringSignal(state: Record<string, any>): SSRSignalFn {
    let signalIndex = 0;

    return function restoringSignal(initial: any, name?: string): any {
        const key = generateSignalKey(name, signalIndex++);

        const seed = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : initial;

        // Live signal — writes go straight through so client reactivity works.
        const sig = signal(seed as any);

        return new Proxy(sig as any, {
            get(target: any, prop: string | symbol) {
                if (prop === 'value') {
                    return target.value;
                }
                return target[prop];
            },
            set(target: any, prop: string | symbol, newValue: any) {
                if (prop === 'value') {
                    target.value = newValue;
                    return true;
                }
                target[prop] = newValue;
                return true;
            }
        });
    } as SSRSignalFn;
}
