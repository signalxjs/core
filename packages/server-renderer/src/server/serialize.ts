/**
 * The one serializer module — shared escaping, key-safety, dev-warning, and
 * type-handler discipline for every state blob the server emits
 * (`__SIGX_ASYNC__`, `__SIGX_BOUNDARIES__`).
 *
 * Type handlers are provided per app via `provideTypeHandlers` from
 * `sigx/internals` (a pack's `install(app)` registers them); the render entry
 * points expose the app context on the request's SSRContext, and every
 * serialization site resolves the chain through `getTypeHandlers`.
 */

import {
    TYPE_HANDLER_TOKEN,
    getProvided,
    encodeWithHandlers,
    BUILTIN_TYPE_HANDLERS,
    type TypeHandler
} from 'sigx/internals';
import type { SSRContext } from './context';
import type { SSRBoundaryRecord } from '../boundary';

export type { TypeHandler };

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
 * Whether the boundary codec owns this value — a registered handler or one of
 * `@sigx/serialize`'s built-in tags (`Date`, `Map`, `Set`, `BigInt`, …).
 *
 * The single question both payload serializers ask. `record.props` and
 * `record.state` used to answer it differently: props consulted registered
 * handlers only, state had no handler parameter at all, so the same `Date`
 * survived as a prop and was dropped with a warning as signal state.
 */
export function codecOwns(value: unknown, handlers: readonly TypeHandler[]): boolean {
    for (const h of handlers) if (h.test(value)) return true;
    for (const h of BUILTIN_TYPE_HANDLERS) if (h.test(value)) return true;
    return false;
}

/**
 * The one admission check for a boundary payload entry: the key must be safe
 * regardless of the value, then the value must either be codec-owned or
 * survive a plain JSON round trip.
 *
 * Key safety is checked FIRST and unconditionally. Props previously skipped
 * `isSerializable` entirely when a handler claimed the value, which took the
 * `DANGEROUS_KEYS` rejection with it — a `__proto__` key holding a `Date`
 * went through. (The null-prototype target in `assignmentJs` still contained
 * it, so this was defence-in-depth rather than a live hole.)
 */
export function admitPayloadEntry(
    key: string,
    value: unknown,
    what: string,
    handlers: readonly TypeHandler[]
): boolean {
    if (DANGEROUS_KEYS.has(key)) {
        if (__DEV__) {
            console.warn(
                `[SSR] ${what} key "${key}" is not allowed ` +
                `(prototype-pollution risk) — value skipped. Pick another key.`
            );
        }
        return false;
    }
    if (codecOwns(value, handlers)) return true;
    return isSerializable(key, value, what);
}

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
 * JSON.stringify with the boundary codec applied — registered handlers first,
 * then `@sigx/serialize`'s built-in vocabulary (`$date`, `$map`, …). Handlers
 * see RAW values (the walk visits objects before `toJSON` runs), which is the
 * only reason `Date` is matchable at all.
 *
 * Every reader of what this emits decodes with `reviveWithHandlers`:
 * `runtime-core/src/async/restore.ts`, `cache/src/store.ts`, and
 * `server-renderer/src/client/scheduler.ts` (`getBoundaryTable`, the single
 * accessor resume and islands both go through). Adding an emitter without a
 * matching decode ships tags the client cannot read — see `docs/seams.md`.
 */
export function stringifyWithHandlers(
    value: unknown,
    handlers: readonly TypeHandler[]
): string {
    return JSON.stringify(encodeWithHandlers(value, handlers));
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
    handlers: readonly TypeHandler[] = []
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
    handlers: readonly TypeHandler[] = []
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

        if (!admitPayloadEntry(key, value, 'boundary prop', handlers)) continue;

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
    // The shell table carries every record known so far — nothing pending.
    ctx._unflushedBoundaries.clear();
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
 *
 * The patch carries the resolved record (re-emitted even when already
 * flushed — plugins mutate it during async re-capture) PLUS every record
 * not yet emitted to the client: boundaries born inside the deferred render
 * (a streamed subtree full of pack-claimed components) exist only in
 * `ctx._boundaries`, never in the shell table (#279).
 */
export function boundaryPatchJs(ctx: SSRContext, id: number): string {
    const patch: Record<number, SSRBoundaryRecord> = {};
    const record = ctx._boundaries.get(id);
    if (record) {
        patch[id] = record;
        ctx._unflushedBoundaries.delete(id);
    }
    // Drain the dirty-set — O(patch size), no per-resolution map rescans.
    for (const unflushedId of ctx._unflushedBoundaries) {
        const unflushed = ctx._boundaries.get(unflushedId);
        if (unflushed) patch[unflushedId] = unflushed;
    }
    ctx._unflushedBoundaries.clear();
    if (Object.keys(patch).length === 0) return '';
    return assignmentJs('__SIGX_BOUNDARIES__', patch, getTypeHandlers(ctx));
}

const NO_HANDLERS: readonly TypeHandler[] = [];

/**
 * Resolve the per-app type-handler chain for this request. Empty when the
 * render input carried no app or no pack registered handlers.
 */
export function getTypeHandlers(ctx: SSRContext): readonly TypeHandler[] {
    const provided = getProvided(ctx._appContext?.provides, TYPE_HANDLER_TOKEN);
    return provided ?? NO_HANDLERS;
}
