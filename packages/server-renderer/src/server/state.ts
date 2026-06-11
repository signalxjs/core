/**
 * __SIGX_ASYNC__ serialization — the hydration state transfer for
 * useAsync/useStream resolved values.
 *
 * The wire format is request-global and keyed by the user's explicit keys
 * (never component IDs or signal positions):
 *
 *   <script>window.__SIGX_ASYNC__ = { "stats": {...}, "user:1": {...} }</script>
 *
 * The client consumes entries once on first use (see runtime-core
 * use-async.ts) — restored mounts skip their fetch entirely.
 */

import { escapeJsonForScript } from './streaming';

/**
 * Raw JS statement merging values into `window.__SIGX_ASYNC__`. Used inside
 * replacement <script>s, where it must run BEFORE the `$SIGX_REPLACE` call
 * that triggers hydration listeners.
 */
export function asyncAssignmentJs(values: Record<string, unknown>): string {
    const json = escapeJsonForScript(JSON.stringify(values));
    // Null-prototype target: keys are user-defined strings, and assigning
    // "__proto__" onto a plain object via Object.assign goes through the
    // prototype setter (prototype pollution). With a null-prototype target
    // dangerous keys become plain data properties.
    return `window.__SIGX_ASYNC__=Object.assign(Object.create(null),window.__SIGX_ASYNC__,${json});`;
}

/** Full `<script>` tag emitting values — flushed with the shell. */
export function serializeAsyncScript(values: Record<string, unknown>): string {
    return `<script>${asyncAssignmentJs(values)}</script>`;
}

/**
 * Validate that a value survives a JSON round trip. Dev-warns and returns
 * false for functions, bigints, undefined, and circular structures.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSerializable(key: string, value: unknown): boolean {
    // Prototype-pollution guard: these keys are interpreted specially by JS
    // object machinery — reject them outright rather than ship them.
    if (DANGEROUS_KEYS.has(key)) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                `[SSR] useAsync/useStream key "${key}" is not allowed ` +
                `(prototype-pollution risk) — value skipped. Pick another key.`
            );
        }
        return false;
    }
    if (typeof value === 'function' || typeof value === 'bigint' || value === undefined) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                `[SSR] useAsync("${key}") resolved to a ${typeof value} — not ` +
                `JSON-serializable, skipped. The client will refetch.`
            );
        }
        return false;
    }
    try {
        JSON.stringify(value);
        return true;
    } catch {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                `[SSR] useAsync("${key}") resolved to a non-JSON-serializable ` +
                `value (circular?), skipped. The client will refetch.`
            );
        }
        return false;
    }
}
