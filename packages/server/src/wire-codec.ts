/**
 * The RPC wire codec (rfc-server §4) — the `@sigx/serialize` boundary codec,
 * bound to the server-function transport.
 *
 * The codec itself is shared, not reimplemented: `@sigx/serialize` has zero
 * dependencies precisely so that `@sigx/server/client` — which is
 * dependency-free by contract (size-limit checks it with no ignore list,
 * because resume handler chunks replicate stub imports) — can import it
 * without dragging a runtime along. What lives here is only the transport
 * binding: where the per-app handlers come from on this particular boundary.
 */

import {
    encodeWithHandlers,
    reviveWithHandlers,
    type TypeHandler
} from '@sigx/serialize';

export type { TypeHandler };

/**
 * Handlers for custom classes, delivered through a GLOBAL — the
 * `__SIGX_SERVERFN_CACHE__` pattern (no import in either direction, so both
 * entries stay dependency-free). The built-in vocabulary works without it;
 * the global only ADDS types. A malformed registry is ignored rather than
 * allowed to break the call.
 */
function handlers(): readonly TypeHandler[] {
    const extra = (globalThis as { __SIGX_SERVERFN_CODEC__?: TypeHandler[] })
        .__SIGX_SERVERFN_CODEC__;
    return Array.isArray(extra) ? extra : [];
}

/** Encode a value for the wire (arguments, results, stream chunks). */
export function encodeWire(value: unknown): unknown {
    return encodeWithHandlers(value, handlers());
}

/** Decode a value off the wire. */
export function reviveWire(value: unknown): unknown {
    return reviveWithHandlers(value, handlers());
}
