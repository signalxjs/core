/**
 * The one serializer module — shared escaping, key-safety, dev-warning, and
 * type-handler discipline for every state blob the server emits
 * (`__SIGX_ASYNC__`, `__SIGX_BOUNDARIES__`).
 *
 * Type handlers are provided per app via `provideSSRSerializerHandlers` from
 * `sigx/internals` (a pack's `install(app)` registers them); the render entry
 * points expose the app context on the request's SSRContext, and every
 * serialization site resolves the chain through `getTypeHandlers`.
 */

import { SSR_SERIALIZER_TOKEN, getProvided, type SSRTypeHandler } from 'sigx/internals';
import type { SSRContext } from './context';

export type { SSRTypeHandler };

/**
 * Escape a JSON string for safe embedding inside <script> tags.
 * Prevents XSS by replacing characters that could break out of the script context.
 */
export function escapeJsonForScript(json: string): string {
    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Open a renderer-emitted `<script>` tag: plain `<script>` without a nonce
 * (byte-identical to the historical output), `<script nonce="...">` when the
 * request carries a CSP nonce. The nonce is server-generated, but it is
 * attribute-escaped anyway — one discipline for every emitted attribute.
 */
export function scriptOpen(nonce?: string): string {
    if (!nonce) return '<script>';
    const escaped = nonce
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `<script nonce="${escaped}">`;
}

/**
 * Keys interpreted specially by JS object machinery — rejected outright
 * rather than shipped (prototype-pollution guard).
 */
export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate that a value survives a JSON round trip. Dev-warns and returns
 * false for dangerous keys, functions, bigints, undefined, and circular
 * structures. `what` labels the warning's source (default: the useAsync
 * wording this check originally shipped with).
 */
export function isSerializable(key: string, value: unknown, what = 'useAsync'): boolean {
    // Consequence differs by payload: a skipped useAsync value refetches on
    // the client; a skipped boundary prop / signal snapshot is simply absent.
    const consequence = what === 'useAsync'
        ? ' The client will refetch.'
        : ' It will be missing on the client.';
    if (DANGEROUS_KEYS.has(key)) {
        if (__DEV__) {
            const label = what === 'useAsync' ? 'useAsync/useStream key' : `${what} key`;
            console.warn(
                `[SSR] ${label} "${key}" is not allowed ` +
                `(prototype-pollution risk) — value skipped. Pick another key.`
            );
        }
        return false;
    }
    if (typeof value === 'function' || typeof value === 'bigint' || value === undefined) {
        if (__DEV__) {
            console.warn(
                `[SSR] ${what}("${key}") resolved to a ${typeof value} — not ` +
                `JSON-serializable, skipped.${consequence}`
            );
        }
        return false;
    }
    try {
        // stringify can also RETURN undefined (symbols, toJSON() returning
        // undefined) — the key would silently vanish from the blob.
        if (JSON.stringify(value) === undefined) {
            if (__DEV__) {
                console.warn(
                    `[SSR] ${what}("${key}") resolved to a value JSON cannot ` +
                    `represent (symbol / toJSON returning undefined), skipped.${consequence}`
                );
            }
            return false;
        }
        return true;
    } catch {
        if (__DEV__) {
            console.warn(
                `[SSR] ${what}("${key}") resolved to a non-JSON-serializable ` +
                `value (circular?), skipped.${consequence}`
            );
        }
        return false;
    }
}

/**
 * JSON.stringify with the type-handler chain applied. Handlers receive the
 * RAW value (read off the holder, before toJSON) so types like Date — whose
 * toJSON would otherwise run first — are still matchable.
 */
export function stringifyWithHandlers(
    value: unknown,
    handlers: readonly SSRTypeHandler[]
): string {
    if (handlers.length === 0) return JSON.stringify(value);
    return JSON.stringify(value, function (this: any, key: string, transformed: unknown) {
        const raw = this[key];
        for (const h of handlers) {
            if (h.test(raw)) return h.serialize(raw);
        }
        return transformed;
    });
}

/**
 * The one assignment discipline for executable state blobs:
 *
 *   window.NAME=Object.assign(Object.create(null),window.NAME,{...});
 *
 * Null-prototype target: keys can be user-defined strings, and assigning
 * "__proto__" onto a plain object via Object.assign goes through the
 * prototype setter (prototype pollution). With a null-prototype target
 * dangerous keys become plain data properties. Used by `__SIGX_ASYNC__`
 * (wire format unchanged) and `__SIGX_BOUNDARIES__`.
 */
export function assignmentJs(
    globalName: string,
    values: Record<string | number, unknown>,
    handlers: readonly SSRTypeHandler[] = []
): string {
    const json = escapeJsonForScript(stringifyWithHandlers(values, handlers));
    return `window.${globalName}=Object.assign(Object.create(null),window.${globalName},${json});`;
}

/**
 * Serialize a props bag for client-side boundary mounting: silently drops
 * framework-internal props (children/key/ref/slots/$models), functions,
 * symbols, undefined, and `on*` event handlers — expected non-transferables —
 * then routes the rest through `isSerializable` (dev-warns on circular,
 * bigint, dangerous keys). Returns undefined when nothing survives.
 *
 * Directive props (e.g. islands' `client:*`) are NOT stripped here — only the
 * pack knows its directive vocabulary; it filters before calling.
 */
export function serializeBoundaryProps(
    props: Record<string, unknown> | null | undefined,
    handlers: readonly SSRTypeHandler[] = []
): Record<string, unknown> | undefined {
    if (!props) return undefined;

    const result: Record<string, unknown> = {};
    let hasProps = false;

    for (const key in props) {
        const value = props[key];

        if (key === 'children' || key === 'key' || key === 'ref' || key === 'slots' || key === '$models') continue;
        if (typeof value === 'function') continue;
        if (typeof value === 'symbol') continue;
        if (value === undefined) continue;
        // Event handlers (onX props).
        if (key.startsWith('on') && key.length > 2 && key[2] === key[2].toUpperCase()) continue;

        // A type handler claiming the value trumps the JSON check.
        let handled = false;
        for (const h of handlers) {
            if (h.test(value)) { handled = true; break; }
        }
        if (!handled && !isSerializable(key, value, 'boundary prop')) continue;

        result[key] = value;
        hasProps = true;
    }

    return hasProps ? result : undefined;
}

/**
 * The shell-time boundary table script — one `__SIGX_BOUNDARIES__`
 * assignment for every recorded boundary. Returns `''` when the table is
 * empty: a page without boundaries emits nothing (the SPA-SSR fast path
 * stays byte-identical).
 */
export function emitBoundaryTable(ctx: SSRContext): string {
    if (ctx._boundaries.size === 0) return '';
    const table: Record<number, unknown> = {};
    ctx._boundaries.forEach((record, id) => {
        table[id] = record;
    });
    return `${scriptOpen(ctx._nonce)}${assignmentJs('__SIGX_BOUNDARIES__', table, getTypeHandlers(ctx))}</script>`;
}

/**
 * The per-id mid-stream table patch — the same assignment statement scoped
 * to one boundary. Rides `generateReplacementScript`'s preScript slot so an
 * updated record (post-async state re-capture) is installed BEFORE
 * `$SIGX_REPLACE` dispatches `sigx:async-ready`. Also covers boundaries
 * first recorded after the shell flushed (e.g. inside a Defer's deferred
 * render): Object.assign onto the (possibly undefined) global creates the
 * entry either way.
 */
export function boundaryPatchJs(ctx: SSRContext, id: number): string {
    const record = ctx._boundaries.get(id);
    if (!record) return '';
    return assignmentJs('__SIGX_BOUNDARIES__', { [id]: record }, getTypeHandlers(ctx));
}

const NO_HANDLERS: readonly SSRTypeHandler[] = [];

/**
 * Resolve the per-app type-handler chain for this request. Empty when the
 * render input carried no app or no pack registered handlers.
 */
export function getTypeHandlers(ctx: SSRContext): readonly SSRTypeHandler[] {
    const provided = getProvided(ctx._appContext?.provides, SSR_SERIALIZER_TOKEN);
    return provided ?? NO_HANDLERS;
}
