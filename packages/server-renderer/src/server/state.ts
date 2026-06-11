/**
 * Server-side signal state capture for automatic hydration state transfer.
 *
 * The client half has existed for a while (`createRestoringSignal` in
 * client/hydrate-context.ts); this module provides the missing server half:
 * track the signals a component creates, snapshot their values after
 * `ssr.load()` resolves, and emit them as an XSS-safe `window.__SIGX_STATE__`
 * blob keyed by component ID. Key parity with the client is guaranteed by
 * sharing `generateSignalKey`.
 */

import { signal } from 'sigx';
import { generateSignalKey, type SSRSignalFn } from './types';
import { escapeJsonForScript } from './streaming';

/**
 * One tracked signal: the signal itself plus how to read its current value.
 * Object signals ARE their (proxied) value; primitive signals expose `.value`.
 * The kind is decided by the initial value at creation time — mirroring how
 * `signal()` itself decides.
 */
interface TrackedSignal {
    s: any;
    isObject: boolean;
}

/** Per-component store of tracked signals, keyed by serialization key. */
export type TrackedSignalStore = Map<string, TrackedSignal>;

/**
 * A `signal()` replacement that records every created signal in `store`
 * under its serialization key (the optional `name` argument, or a positional
 * `$N` fallback — same contract as the client's `createRestoringSignal`).
 */
export function createTrackingSignal(store: TrackedSignalStore): SSRSignalFn {
    let signalIndex = 0;

    return function trackingSignal(initial: any, name?: string): any {
        const key = generateSignalKey(name, signalIndex++);
        const s = signal(initial as any);
        store.set(key, {
            s,
            isObject: typeof initial === 'object' && initial !== null
        });
        return s;
    } as SSRSignalFn;
}

/**
 * Snapshot the current values of all tracked signals.
 *
 * Returns null when there is nothing to capture. In dev, warns about (and
 * skips) values that cannot survive a JSON round trip — functions, undefined,
 * bigints, circular structures.
 */
export function captureSignalState(
    store: TrackedSignalStore,
    componentName: string
): Record<string, any> | null {
    if (store.size === 0) return null;

    const out: Record<string, any> = {};
    for (const [key, tracked] of store) {
        const value = tracked.isObject ? tracked.s : tracked.s.value;

        if (typeof value === 'function' || typeof value === 'bigint' || value === undefined) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(
                    `[SSR State] Signal "${key}" in <${componentName}> holds a ` +
                    `${typeof value} — not JSON-serializable, skipped. ` +
                    `The client will fall back to the signal's initial value.`
                );
            }
            continue;
        }

        try {
            // Validates serializability (catches circular structures) — the
            // result is discarded; the blob is stringified once at emit time.
            JSON.stringify(value);
        } catch {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(
                    `[SSR State] Signal "${key}" in <${componentName}> is not ` +
                    `JSON-serializable (circular?), skipped. ` +
                    `The client will fall back to the signal's initial value.`
                );
            }
            continue;
        }

        out[key] = value;
    }

    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Raw JS statement that merges captured states into `window.__SIGX_STATE__`.
 * Used standalone inside replacement <script>s (must run BEFORE the
 * `$SIGX_REPLACE` call that triggers hydration listeners).
 */
export function stateAssignmentJs(states: Record<number, Record<string, any>>): string {
    const json = escapeJsonForScript(JSON.stringify(states));
    return `window.__SIGX_STATE__=Object.assign(window.__SIGX_STATE__||{},${json});`;
}

/**
 * Full `<script>` tag emitting captured states — appended after the shell
 * (string mode) or flushed with it (document streaming).
 */
export function serializeStateScript(states: Record<number, Record<string, any>>): string {
    return `<script>${stateAssignmentJs(states)}</script>`;
}
