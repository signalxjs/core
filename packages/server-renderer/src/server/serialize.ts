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
    BUILTIN_TYPE_HANDLERS,
    type TypeHandler
} from 'sigx/internals';
// Imported straight from the codec package, not re-exported through
// `sigx/internals`: this is an opt-in SUBPATH kept out of the size-limited
// root entry on purpose (#657), and routing it through the internals barrel
// would hand it to every client bundle that imports one. This module is
// server-only, and @sigx/serialize is already external here, so the
// dependency costs nothing in any size row.
import { stringifyWithHandlers as stringifyJSON } from '@sigx/serialize/stringify';
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
 * The document-complete signal — THE one emitter, used by every streaming
 * path (`ssr.ts`'s generator and callback APIs, `document.ts`). It used to be
 * three byte-identical copies of this literal, which is a drift hazard on a
 * string that `scripts/deploy-smoke/assertions.mjs` and
 * `packages/server-renderer/scripts/edge-smoke.mjs` assert verbatim.
 *
 * `__SIGX_STREAMING_COMPLETE__` stays a plain (enumerable) global, unlike the
 * pack-internal seams: it is written by this emitted script, so hiding it
 * would change wire bytes, and it is an APP-FACING contract — nothing in
 * `packages/**\/src` reads it. The `sigx:ready` event is the half most apps
 * should use; the flag exists for code that starts after the event fired.
 */
export function completionScript(nonce?: string): string {
    return `${scriptOpen(nonce)}window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));</script>`;
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
 * The one admission check for a serialized payload entry — boundary props,
 * state signals, and the `__SIGX_ASYNC__` blob (#420) all ask it: the key
 * must be safe regardless of the value, then the value must either be
 * codec-owned or survive the CODEC-AWARE round trip.
 *
 * Key safety is checked FIRST and unconditionally. Props previously skipped
 * `isSerializable` entirely when a handler claimed the value, which took the
 * `DANGEROUS_KEYS` rejection with it — a `__proto__` key holding a `Date`
 * went through. (The null-prototype target in `assignmentJs` still contained
 * it, so this was defence-in-depth rather than a live hole.)
 *
 * The fallback round trip runs `stringifyWithHandlers`, not plain
 * `JSON.stringify` (#420): a handler-owned value NESTED inside a plain
 * object (a `bigint` in a snapshot, a `Map` in a props bag) is encodable
 * even though plain JSON would throw on it or drop it — the admission test
 * must ask the same encoder the emitter uses, or it rejects values the wire
 * handles fine.
 */
export function admitPayloadEntry(
    key: string,
    value: unknown,
    what: string,
    handlers: readonly TypeHandler[]
): boolean {
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
    if (codecOwns(value, handlers)) return true;
    return isSerializable(key, value, what, handlers);
}

/**
 * Validate that a value survives a wire round trip. Dev-warns and returns
 * false for dangerous keys, functions, and circular structures. `what`
 * labels the warning's source (default: the useAsync wording this check
 * originally shipped with).
 *
 * With `handlers` passed (the codec-aware mode `admitPayloadEntry` uses,
 * #420) the round trip is `stringifyWithHandlers` — registered handlers AND
 * the built-in vocabulary apply at every depth, so a nested `bigint`/`Map`
 * is admitted. Without it, the test is plain `JSON.stringify` — top-level
 * bigints and undefined are rejected outright (callers wanting the codec's
 * answer go through `admitPayloadEntry`, whose `codecOwns` short-circuit
 * admits those before this check runs).
 */
export function isSerializable(
    key: string,
    value: unknown,
    what = 'useAsync',
    handlers?: readonly TypeHandler[]
): boolean {
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
    // Functions never serialize. bigint/undefined are plain-JSON rejects only:
    // in codec-aware mode the built-in vocabulary tags both ($bigint, $undef).
    if (typeof value === 'function' || (!handlers && (typeof value === 'bigint' || value === undefined))) {
        if (__DEV__) {
            console.warn(
                `[SSR] ${what}("${key}") resolved to a ${typeof value} — not ` +
                `JSON-serializable, skipped.${consequence}`
            );
        }
        return false;
    }
    try {
        // stringify can also RETURN undefined, and the key would then silently
        // vanish from the blob. Plain JSON does that for a symbol and for a
        // `toJSON` returning undefined; in codec-aware mode only the symbol
        // (and a function) survives as undefined — `$undef` claims the rest.
        const json = handlers ? stringifyJSON(value, handlers) : JSON.stringify(value);
        if (json === undefined) {
            if (__DEV__) {
                console.warn(
                    `[SSR] ${what}("${key}") resolved to a value JSON cannot ` +
                    `represent (a symbol${handlers ? '' : ' / toJSON returning undefined'}), ` +
                    `skipped.${consequence}`
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
 * One walk since #657: this used to be
 * `JSON.stringify(encodeWithHandlers(value, handlers))`, which built a whole
 * JSON-safe tree only for stringify to re-walk and the caller to discard a
 * statement later. `@sigx/serialize/stringify` emits the same bytes straight
 * to a string — byte-for-byte the same bytes, held there by a differential
 * suite, because everything this returns lands on a wire a client parses.
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
    // The cast is `JSON.stringify`'s own lie, kept deliberately. This CAN
    // return undefined — for a top-level symbol or function, and only those
    // (a `toJSON` returning undefined comes back `{"$undef":0}`, because the
    // built-in vocabulary claims it). Every emitter below concatenates the
    // result into a <script> body and wants a `string`; the one caller that
    // branches on the undefined, `isSerializable`, calls `stringifyJSON`
    // directly so its check is type-checked rather than merely tolerated.
    return stringifyJSON(value, handlers) as string;
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
