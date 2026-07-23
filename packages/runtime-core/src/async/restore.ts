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
 * Read a server-serialized value for `key` from the page blob.
 *
 * THE decode point for `__SIGX_ASYNC__` — `@sigx/cache` reads through this
 * too, so the codec is applied in exactly one place. Decoding must stay
 * idempotent: the blob is a MIXED store, holding server-encoded values
 * alongside live ones `writeBack` put there after a client fetch
 * (`reviveWithHandlers` returns non-plain objects untouched — #369).
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

/** Invalidate a restored entry — called before fetching fresh data. */
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
