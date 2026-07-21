/**
 * The RPC wire codec (rfc-server §4) — how non-JSON types survive the
 * request and response envelopes in both directions.
 *
 * DUPLICATED, DELIBERATELY. This is a second implementation of the tag
 * vocabulary specified by `packages/runtime-core/src/ssr-serialize.ts`
 * (`encodeWithHandlers` / `reviveWithHandlers`). `@sigx/server` has ZERO
 * dependencies — not even `sigx` — because `@sigx/server/client` is
 * dependency-free by contract: size-limit checks that entry with no ignore
 * list, since resume handler chunks replicate stub imports and must not drag
 * a runtime along. Importing runtime-core here would break that guard, so the
 * codec is reimplemented instead, the same way `DANGEROUS_KEYS` is.
 *
 * The vocabulary is the shared spec both copies obey — change one and you
 * MUST change the other:
 *
 *   $date  $map  $set  $bigint  $url  $regexp  $undef      $esc (collision escape)
 *
 * This module is imported by BOTH the `/server` and `/client` entries; the
 * bundler emits it as a shared chunk, and size-limit's esbuild pass follows
 * the import, so its bytes are still counted against the stub's ceiling.
 */

/** One pluggable codec entry — structurally the `SSRTypeHandler` shape. */
export interface WireTypeHandler {
    name: string;
    tag: string;
    test(value: unknown): boolean;
    serialize(value: unknown): unknown;
    revive(encoded: unknown): unknown;
}

const ESCAPE_TAG = '$esc';

const BUILTINS: WireTypeHandler[] = [
    {
        name: 'date',
        tag: '$date',
        test: (v) => v instanceof Date,
        serialize: (v) => {
            const t = (v as Date).getTime();
            return Number.isNaN(t) ? null : t;
        },
        revive: (v) => new Date(v === null ? NaN : (v as number))
    },
    {
        name: 'map',
        tag: '$map',
        test: (v) => v instanceof Map,
        serialize: (v) => [...(v as Map<unknown, unknown>).entries()],
        revive: (v) => new Map(v as [unknown, unknown][])
    },
    {
        name: 'set',
        tag: '$set',
        test: (v) => v instanceof Set,
        serialize: (v) => [...(v as Set<unknown>)],
        revive: (v) => new Set(v as unknown[])
    },
    {
        name: 'bigint',
        tag: '$bigint',
        test: (v) => typeof v === 'bigint',
        serialize: (v) => (v as bigint).toString(),
        revive: (v) => BigInt(v as string)
    },
    {
        name: 'url',
        tag: '$url',
        test: (v) => typeof URL !== 'undefined' && v instanceof URL,
        serialize: (v) => (v as URL).href,
        revive: (v) => new URL(v as string)
    },
    {
        name: 'regexp',
        tag: '$regexp',
        test: (v) => v instanceof RegExp,
        serialize: (v) => [(v as RegExp).source, (v as RegExp).flags],
        revive: (v) => new RegExp((v as string[])[0]!, (v as string[])[1])
    },
    {
        name: 'undefined',
        tag: '$undef',
        test: (v) => v === undefined,
        serialize: () => 0,
        revive: () => undefined
    }
];

/**
 * App-registered handlers for custom classes, delivered through a GLOBAL —
 * the `__SIGX_SERVERFN_CACHE__` pattern (no import in either direction, so
 * both entries stay dependency-free). Built-ins work without it; the global
 * only ADDS types. A malformed or throwing registry never breaks the call.
 */
function registry(): WireTypeHandler[] {
    const extra = (globalThis as { __SIGX_SERVERFN_CODEC__?: WireTypeHandler[] })
        .__SIGX_SERVERFN_CODEC__;
    return Array.isArray(extra) ? extra : [];
}

/** Registry first, so a pack can own a type the built-ins also cover. */
function chain(): WireTypeHandler[] {
    const extra = registry();
    return extra.length === 0 ? BUILTINS : [...extra, ...BUILTINS];
}

function needsEscape(encoded: Record<string, unknown>): boolean {
    const keys = Object.keys(encoded);
    return keys.length === 1 && keys[0]!.charCodeAt(0) === 36 /* $ */;
}

/**
 * Walk a value into a JSON-safe tree. Handlers see RAW values (the walk
 * visits objects before `toJSON` runs — the only reason `Date` is matchable),
 * and `toJSON` is honored for values no handler claims.
 */
export function encodeWire(value: unknown): unknown {
    return enc(value, chain(), new Set(), true);
}

function enc(
    value: unknown,
    handlers: WireTypeHandler[],
    seen: Set<object>,
    escapeTop: boolean
): unknown {
    for (const h of handlers) {
        if (h.test(value)) return { [h.tag]: enc(h.serialize(value), handlers, seen, true) };
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new TypeError('Converting circular structure to JSON');

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    seen.add(value);
    try {
        if (typeof toJSON === 'function') {
            return enc((toJSON as () => unknown).call(value), handlers, seen, escapeTop);
        }
        if (Array.isArray(value)) return value.map((v) => enc(v, handlers, seen, true));
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            out[key] = enc((value as Record<string, unknown>)[key], handlers, seen, true);
        }
        return escapeTop && needsEscape(out) ? { [ESCAPE_TAG]: out } : out;
    } finally {
        seen.delete(value);
    }
}

/**
 * Turn `{ [tag]: payload }` objects back into live values. An unrecognized
 * `$`-tag is left untouched, so a peer on a newer vocabulary degrades to the
 * raw shape rather than throwing — which is why the envelope needs no
 * version field.
 */
export function reviveWire(value: unknown): unknown {
    return rev(value, chain());
}

function rev(value: unknown, handlers: WireTypeHandler[]): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => rev(v, handlers));

    const keys = Object.keys(value);
    if (keys.length === 1) {
        const key = keys[0]!;
        const payload = (value as Record<string, unknown>)[key];
        // Only unwrap a payload this codec could have produced — the encoder
        // always wraps an OBJECT. A `{ $esc: 1 }` that was never encoded
        // falls through and survives as itself, instead of becoming `{}` via
        // `Object.keys(1)`.
        if (
            key === ESCAPE_TAG &&
            payload !== null &&
            typeof payload === 'object' &&
            !Array.isArray(payload)
        ) {
            // Unwrap one level, reviving the VALUES but never reading the
            // unwrapped object's own key as a tag — that is the whole point.
            const inner = payload as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(inner)) out[k] = rev(inner[k], handlers);
            return out;
        }
        if (key.charCodeAt(0) === 36 /* $ */ && key !== ESCAPE_TAG) {
            for (const h of handlers) {
                if (h.tag === key) return h.revive(rev(payload, handlers));
            }
        }
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = rev((value as Record<string, unknown>)[key], handlers);
    return out;
}
