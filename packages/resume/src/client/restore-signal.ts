/**
 * Client-side signal restoration for resume upgrades.
 *
 * Counterpart to the server's tracking signal (`server/track-signal.ts`),
 * and a sibling of the islands restore factory (#241 tracks hoisting the
 * pair into @sigx/server-renderer — seam PR d): during upgrade the
 * component's `ctx.signal` is swapped for this variant so each declared
 * signal seeds from the ORIGINAL server-captured state (the DOM matches it;
 * buffered writes replay afterwards).
 *
 * Beyond the islands sibling it takes a `report` callback: each named live
 * signal is handed back so the scope's facades can re-point to it.
 */

import { signal } from 'sigx';
import type { ResumeSignalFn } from '../server/track-signal';

export function createRestoringSignal(
    state: Record<string, any>,
    report: ((name: string, live: { value: any }) => void) | null
): ResumeSignalFn {
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
                    `[sigx resume] Duplicate resume state key "${name}" — two signals in the same ` +
                    `component resolve to the same declaration name. The first keeps the key; this ` +
                    `one stays local-only (not restored). Declare each transferred signal with a ` +
                    `distinct variable name.`
                );
            }
            return signal(initial as any);
        }
        seen.add(name);

        const seed = Object.prototype.hasOwnProperty.call(state, name) ? state[name] : initial;
        const sig = signal(seed as any);

        // Uniform `{ value }` shape for primitives AND objects — the same
        // interface the tracking signal produced on the server.
        const live = new Proxy(sig as any, {
            get(target: any, prop: string | symbol, receiver: any) {
                if (prop === 'value') {
                    return target.value;
                }
                return Reflect.get(target, prop, receiver);
            },
            set(target: any, prop: string | symbol, next: any, receiver: any) {
                if (prop === 'value') {
                    target.value = next;
                    return true;
                }
                return Reflect.set(target, prop, next, receiver);
            }
        });

        report?.(name, live);
        return live;
    } as ResumeSignalFn;
}
