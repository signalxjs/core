/**
 * Serialized-state pickup — the ONLY module that touches the page blob
 * (`window.__SIGX_ASYNC__`, emitted by the server renderer).
 *
 * The blob is the page's DATA CACHE for its lifetime: every mount of the
 * same key restores from it (two components sharing a key both restore —
 * neither refetches), including remounts after client-side navigation.
 * Successful keyed fetches write back, so the cache always holds the
 * latest value regardless of whether SSR seeded the key. `refresh()`
 * invalidates the entry, fetches fresh, and repopulates on success.
 *
 * Every accessor is gated on `isLiveClient()` (#407): servers stay inert
 * (no declaration + no window → false), browsers are live via the
 * `typeof window` fallback, and windowless live clients (lynx, terminal —
 * they call `declareLiveClient(true)` at import) get blob access too. The
 * blob's transport is host-provided: an HTML `<script>` on web, an
 * embedder-installed `globalThis.__SIGX_ASYNC__` elsewhere — which is why
 * the reads below go through `globalThis`, never `window`. Declaration
 * wins in both directions: `declareLiveClient(false)` makes the accessors
 * inert even where a window exists.
 *
 * This module is also THE decode point for the blob: `@sigx/cache` reads
 * through `peekRestored` rather than touching the global, so the boundary
 * codec is applied in exactly one place.
 */

import { reviveWithHandlers, type TypeHandler } from '@sigx/serialize';
import { isLiveClient } from './environment.js';

const MISS = { hit: false, value: undefined } as const;

/**
 * The `__SIGX_ASYNC__` seam's shape at its single accessor — the canonical
 * contract lives in `docs/seams.md`. Null-prototype record of key →
 * (server-encoded | live written-back) value.
 */
type AsyncBlobGlobal = { __SIGX_ASYNC__?: Record<string, unknown> };

/**
 * Handlers for app/pack types, delivered through a page global rather than DI
 * — see `docs/seams.md`. The blob is itself a page global, so a per-app
 * decoder for it would be meaningless, and the read sites here run inside
 * reactive effects where no app context is reliably current.
 * `provideTypeHandlers` stamps this alongside the DI token; the built-in
 * vocabulary works without it.
 */
function typeHandlers(): readonly TypeHandler[] {
    const extra = (globalThis as { __SIGX_TYPE_HANDLERS__?: TypeHandler[] })
        .__SIGX_TYPE_HANDLERS__;
    return Array.isArray(extra) ? extra : [];
}

/**
 * Decode a value that came from the server — THE one operation for it.
 *
 * The blob path calls this internally; the boundary paths (`record.props`,
 * `record.state`, consumed by the hydration core, resume and islands) call it
 * at their own point of use. It deliberately is NOT applied inside
 * `getBoundaryTable`/`seedBoundaryState`: both sit in the EAGER scheduler
 * bundle, whose size-limit entry carries no ignore list precisely to guarantee
 * no runtime reaches the eager path, and the codec would cost ~750 B of a 3 KB
 * budget. The eager path only reads boundary METADATA (`hydrate`, `media`,
 * `flush`, `chunk`) — never user values — so decoding belongs in the lazy
 * chunks that actually mount components.
 *
 * Idempotent: safe on values already revived, and on live values written
 * client-side (#369).
 */
export function reviveFromServer(value: unknown): unknown {
    return reviveWithHandlers(value, typeHandlers());
}

/**
 * Read the value stored under `key` in the page's `__SIGX_ASYNC__` blob —
 * the READ half of the blob's public contract (#449; `docs/seams.md`).
 *
 * The blob is the page's data cache for its lifetime: the server fills it
 * (`ctx.registerSerializedState` is the public writer) and successful keyed
 * client fetches write back into it, so a state-owning pack seeding from it
 * gets the latest value regardless of which side produced it. Reading does
 * NOT consume: the entry stays for every later mount that asks — the
 * default every first-party reader (`useData`, `useStream`, `@sigx/cache`)
 * relies on. A pack whose seed must not outlive its own instance pairs the
 * read with {@link invalidateRestored}; that is an opt-in, never the default,
 * because a consuming reader starves every later instance under islands and
 * separately-upgraded resume boundaries.
 *
 * - `hit` is own-key membership, not truthiness: a transferred `null` (or a
 *   codec-carried `undefined`) is a hit.
 * - Servers get a miss unconditionally — the accessors gate on
 *   `isLiveClient()` (#407), so a long-lived Node process never leaks one
 *   request's blob into another. Windowless live clients (lynx, terminal)
 *   declare themselves via `declareLiveClient(true)`.
 * - THE decode point for the seam: the boundary codec is applied here and
 *   nowhere else (`@sigx/cache` reads through this too). Decoding stays
 *   idempotent because the blob is a MIXED store — server-encoded values sit
 *   beside live ones `writeBack` put there (`reviveWithHandlers` returns
 *   non-plain objects untouched — #369).
 * - **The value is shared with the blob, not a private copy.** Plain JSON
 *   happens to be rebuilt by the codec walk, but a live value written back
 *   after a client fetch — a `Map`, a `Set`, a class instance, anything the
 *   codec leaves untouched — comes back by reference, and nothing in this
 *   contract promises otherwise. A pack that turns the value into reactive
 *   state must copy it first: a store proxying the blob's own objects writes
 *   its mutations straight back into the blob, and from there into every
 *   instance seeded afterwards.
 */
export function peekRestored(key: string): { hit: boolean; value: unknown } {
    if (!isLiveClient()) return MISS;
    const blob = (globalThis as AsyncBlobGlobal).__SIGX_ASYNC__;
    // Own-property check: `in` would also see inherited keys (and misbehave
    // on keys like "__proto__"/"constructor").
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        return { hit: true, value: reviveFromServer(blob[key]) };
    }
    return MISS;
}

/**
 * Every key currently in the page blob.
 *
 * For pattern-driven invalidation (#484): a matching key with nothing mounted
 * on it must still be swept, or the next mount restores the stale value as
 * `ready` and never fetches. Returns own keys only, on the same
 * null-prototype blob `writeBack` maintains.
 */
export function restoredKeys(): string[] {
    if (!isLiveClient()) return [];
    const blob = (globalThis as AsyncBlobGlobal).__SIGX_ASYNC__;
    return blob ? Object.keys(blob) : [];
}

/**
 * Drop the entry stored under `key` — the INVALIDATE half of the blob's
 * public contract (#449; `docs/seams.md`).
 *
 * The cache calls this before fetching fresh data, so a later mount fetches
 * instead of restoring a value that is no longer the truth. A state-owning
 * pack calls it right after {@link peekRestored} to give a seed
 * instance scope (consume-once) — `@sigx/store`'s `ssrState(ctx, slice,
 * { scope: 'instance' })` is that opt-in; leaving the entry in place is the
 * default, because the blob is a page-lifetime cache every later instance
 * seeds from. A no-op for a missing key, and on the server (`isLiveClient()`
 * gate, #407).
 *
 * Pattern-driven invalidation across mounted cells AND the blob is
 * `invalidateKeys(patterns)` (`@sigx/runtime-core/internals`), which sweeps
 * both halves — this function is the blob half only.
 */
export function invalidateRestored(key: string): void {
    if (!isLiveClient()) return;
    const blob = (globalThis as AsyncBlobGlobal).__SIGX_ASYNC__;
    if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
        delete blob[key];
    }
}

/**
 * Write a successful keyed fetch back into the page cache so later mounts
 * restore the LATEST value — identical behavior whether or not SSR seeded
 * the key. (Null-prototype blob — see the server emitter.)
 */
export function writeBack(key: string, value: unknown): void {
    if (!isLiveClient()) return;
    const g = globalThis as AsyncBlobGlobal;
    const blob = (g.__SIGX_ASYNC__ ??= Object.create(null) as Record<string, unknown>);
    blob[key] = value;
}
