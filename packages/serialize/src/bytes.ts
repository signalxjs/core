/**
 * Opt-in binary vocabulary for the boundary codec (#569).
 *
 * OPT-IN, never built-in, by budget: the root entry is size-limited at 1 KB
 * with no ignore list possible, and `@sigx/server/client` — the "stubs drag
 * no runtime" guard — bundles it. A built-in `$bytes` would tax every client
 * bundle and silently start admitting binary into the SSR state blob. This
 * module is a separate subpath (`@sigx/serialize/bytes`, `sideEffects: false`)
 * so not registering it costs zero bytes.
 *
 * Register it once per side, on whichever seams the app uses:
 *
 * ```ts
 * // App/client side — RPC wire AND the state/boundary registry (#413):
 * app.use(serverPlugin({ transport, types: [bytesHandler] }));
 *
 * // Endpoint-only process (no app): the RPC wire alone:
 * registerWireTypeHandlers([bytesHandler]);   // from '@sigx/server/plugin'
 *
 * // SSR state blob / boundary props without the server plugin:
 * provideTypeHandlers(app._context, [bytesHandler]);
 * ```
 *
 * Registering it also silences the #565 dev warning for exactly the values
 * it claims (`warnUnencodable` skips anything a registered handler's `test`
 * owns).
 *
 * Scope, deliberately:
 * - `Uint8Array` (including Node `Buffer`, which IS one — it revives as a
 *   plain `Uint8Array`) and every other standard `ArrayBuffer` view plus
 *   bare `ArrayBuffer` round-trip to their exact constructor.
 * - A view encodes its WINDOW (`byteOffset`/`byteLength`), never the whole
 *   underlying buffer.
 * - Multi-byte kinds carry raw bytes in host byte order — the same trade
 *   `structuredClone`'s serialization makes; every mainstream JS runtime is
 *   little-endian.
 * - `Blob`/`File` are OUT: the codec is synchronous and they are async-read.
 *   They arrive inbound via `form: true`; they cannot go outbound.
 * - `Float16Array` and `SharedArrayBuffer` are unclaimed and keep the dev
 *   warning — honest, since this handler could not revive them faithfully.
 * - A detached `ArrayBuffer` throws on encode (`new Uint8Array(detached)`),
 *   loudly — consistent with how cycles fail. Malformed wire (bad base64, a
 *   byte length no element size divides) throws from `atob`/the constructor,
 *   the same posture built-ins like `$regexp` take on attacker-typable data.
 *
 * Wire form, one tag: `Uint8Array` — the overwhelmingly common case — is a
 * bare base64 string `{"$bytes":"AQID"}`; every other kind is a
 * `[kind, base64]` tuple `{"$bytes":["Int32Array","…"]}`. Base64 is ~33 %
 * over raw; multi-megabyte payloads are better served as real file
 * responses than through an RPC envelope.
 */

import type { TypeHandler } from './index.js';

/** `String.fromCharCode.apply` argument-count ceiling. */
const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
    // Byte-by-byte binary string, so btoa's latin1 constraint never bites.
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK) as unknown as number[]
        );
    }
    return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

type ViewCtor = new (buffer: ArrayBuffer) => ArrayBufferView;

/**
 * Ordered: Node `Buffer` is a `Uint8Array` subclass and must match it FIRST,
 * so it takes the bare-string form and revives as a plain `Uint8Array`.
 */
const KINDS: readonly (readonly [string, ViewCtor])[] = [
    ['Uint8Array', Uint8Array],
    ['Int8Array', Int8Array],
    ['Uint8ClampedArray', Uint8ClampedArray],
    ['Int16Array', Int16Array],
    ['Uint16Array', Uint16Array],
    ['Int32Array', Int32Array],
    ['Uint32Array', Uint32Array],
    ['Float32Array', Float32Array],
    ['Float64Array', Float64Array],
    ['BigInt64Array', BigInt64Array],
    ['BigUint64Array', BigUint64Array],
    ['DataView', DataView]
];

export type BytesWire = string | [kind: string, b64: string];
export type Bytes = ArrayBuffer | ArrayBufferView;

/**
 * A view backed by a SharedArrayBuffer is NOT claimed: it would revive as an
 * ArrayBuffer-backed view — bytes preserved, shared-ness silently lost — and
 * claiming it would also silence the #565 warning for a value this module's
 * own scope declares unsupported.
 */
const sharedBacked = (v: ArrayBufferView): boolean =>
    typeof SharedArrayBuffer !== 'undefined' && v.buffer instanceof SharedArrayBuffer;

export const bytesHandler = {
    name: 'bytes',
    tag: '$bytes',
    // Exactly the values it can revive faithfully — a subset of what the
    // #565 warning flags, so anything still unclaimed keeps warning.
    test: (v: unknown): boolean =>
        v instanceof ArrayBuffer ||
        (ArrayBuffer.isView(v) && !sharedBacked(v) && KINDS.some(([, C]) => v instanceof C)),
    serialize: (v: Bytes): BytesWire => {
        if (v instanceof ArrayBuffer) return ['ArrayBuffer', toBase64(new Uint8Array(v))];
        // The view's WINDOW, not the whole buffer.
        const b64 = toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        for (const [kind, C] of KINDS) {
            if (v instanceof C) return kind === 'Uint8Array' ? b64 : [kind, b64];
        }
        /* v8 ignore next -- unreachable: `test` gates on the same table */
        return b64;
    },
    revive: (wire: BytesWire): Bytes => {
        if (typeof wire === 'string') return fromBase64(wire);
        const [kind, b64] = wire;
        const bytes = fromBase64(b64);
        if (kind === 'ArrayBuffer') return bytes.buffer;
        for (const [name, C] of KINDS) if (name === kind) return new C(bytes.buffer);
        if (__DEV__) {
            console.warn(
                `[sigx serialize] $bytes: unknown view kind "${kind}" — reviving as a ` +
                `Uint8Array (bytes preserved; written by a newer vocabulary?)`
            );
        }
        return bytes;
    }
} satisfies TypeHandler<Bytes, BytesWire>;
