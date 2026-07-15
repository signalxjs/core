/**
 * Signal tracking and state serialization for resume state transfer.
 *
 * A verbatim sibling of `@sigx/ssr-islands`'s tracking pair (its
 * `server/render-component.ts`): the mechanism is strategy-agnostic — capture
 * named-signal values during server setup so the client can rebuild them —
 * and #241 tracks hoisting it into `@sigx/server-renderer` so both packs
 * re-export one copy (seam PR d). Until then, resume keeps its own.
 */

import { signal } from 'sigx';
import { isSerializable } from '@sigx/server-renderer/server';

/**
 * Signal factory used by resumable components on the server. Mirrors the
 * `signal()` call shape with an optional trailing `name` used as the
 * serialization key — injected into generated code by the `sigxResume()`
 * Vite transform (never public component API), derived from the declaration
 * identifier (`const state = ctx.signal(…)` → key `"state"`).
 *
 * Named = transferred: a signal without a key is plain local state — created,
 * never captured. On the client the same names become the resumed scope's
 * `$scope.signals.<name>` entries, so handler rewrites and state capture key
 * off the same identifiers.
 */
export type ResumeSignalFn = <T>(initial: T, name?: string) => { value: T };

/**
 * Creates a tracking signal function that records signal keys and values.
 * Supports both primitive and object signals.
 */
export function createTrackingSignal(signalMap: Map<string, any>): ResumeSignalFn {
    return function trackingSignal(initial: any, name?: string): any {
        // No key → local-only state: nothing to transfer under.
        if (!name) {
            return signal(initial as any);
        }

        // Duplicate key within one boundary: first wins, later ones stay
        // local so restoration can never mis-map values.
        if (signalMap.has(name)) {
            if (__DEV__) {
                console.warn(
                    `[sigx resume] Duplicate resume state key "${name}" — two signals in the same ` +
                    `component resolve to the same declaration name. The first keeps the key; this ` +
                    `one stays local-only (not transferred). Declare each transferred signal with ` +
                    `a distinct variable name.`
                );
            }
            return signal(initial as any);
        }

        const key = name;
        const sig = signal(initial as any);
        signalMap.set(key, initial);

        // Track writes to .value so the captured state follows the render.
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
                    signalMap.set(key, newValue);
                    return true;
                }
                target[prop] = newValue;
                return true;
            }
        }) as any;
    } as ResumeSignalFn;
}

/**
 * Serialize captured signal state for the boundary record. Serializability
 * checks route through the shared serializer discipline in
 * `@sigx/server-renderer` — one dev-warning path for every blob.
 */
export function serializeSignalState(signalMap: Map<string, any>): Record<string, any> | undefined {
    if (signalMap.size === 0) return undefined;

    const state: Record<string, any> = {};
    for (const [key, value] of signalMap) {
        if (isSerializable(key, value, 'resume signal')) {
            state[key] = value;
        }
    }
    return Object.keys(state).length > 0 ? state : undefined;
}
