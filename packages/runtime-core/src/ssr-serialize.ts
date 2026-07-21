/**
 * The serializer type-handler seam — how non-JSON types (Date, Map, Set,
 * BigInt, custom classes, …) survive every boundary sigx ships state across:
 * the SSR state blob, resume boundary props, the cache seed, and the
 * server-function RPC wire.
 *
 * Two halves, deliberately symmetric:
 *
 *   encodeWithHandlers(value, handlers)  →  a JSON-safe tree
 *   reviveWithHandlers(value, handlers)  →  the live values back
 *
 * A built-in tag vocabulary (`$date`, `$map`, `$set`, `$bigint`, `$url`,
 * `$regexp`, `$undef`) works with zero configuration; the per-app registry
 * below adds custom types on top and is consulted FIRST, so a pack can own a
 * type the built-ins also cover.
 *
 * This file is deliberately SSR-free (plain value walks plus a token and a Map
 * write) and lives in runtime-core so packs can register from `install(app)` in
 * client bundles without importing `@sigx/server-renderer`. Mirrors the async
 * engine seam (`ASYNC_ENGINE_TOKEN` / `provideAsyncEngine`).
 *
 * Note for `@sigx/server/client`: that entry is dependency-free by contract
 * (size-limit checks it with no ignore list, because resume handler chunks
 * replicate stub imports), so it inlines its own copy of the codec rather than
 * importing this module. The vocabulary below is the shared spec both obey —
 * change one and you must change the other.
 */

import { createToken, getProvided, setProvided } from './di/token.js';

/** One pluggable serializer for a non-JSON-representable type. */
export interface SSRTypeHandler {
    /** Identifies the handler (dev warnings, dedupe by consumers). */
    name: string;
    /**
     * Wire discriminator for this handler's encoding, e.g. `'$date'`. Encoded
     * values take the single-key form `{ [tag]: payload }`, which is what makes
     * the revive half able to find them again.
     *
     * Optional for backward compatibility with serialize-only handlers written
     * before the revive half existed; such a handler's output is emitted as-is
     * and never revived.
     */
    tag?: string;
    /** Whether this handler owns the value. Receives the RAW value (before any toJSON). */
    test(value: unknown): boolean;
    /**
     * Return a JSON-safe payload for the value. The result is wrapped as
     * `{ [tag]: payload }` when `tag` is set, and is itself walked, so a
     * handler may return values that other handlers own (e.g. a `Map`'s
     * entries containing `Date`s).
     */
    serialize(value: unknown): unknown;
    /** Turn a payload produced by `serialize` back into the live value. */
    revive?(encoded: unknown): unknown;
}

/**
 * Marks a plain object that would otherwise be mistaken for a tagged value —
 * a user object shaped `{ $date: … }` is emitted as `{ $esc: { $date: … } }`
 * and unwrapped on revive without interpreting the inner key.
 */
const ESCAPE_TAG = '$esc';

/** The zero-config vocabulary. Consulted after any registry handlers. */
export const BUILTIN_TYPE_HANDLERS: readonly SSRTypeHandler[] = [
    {
        name: 'date',
        tag: '$date',
        test: (v) => v instanceof Date,
        // NaN is not representable in JSON; null round-trips back to Invalid Date.
        serialize: (v) => {
            const t = (v as Date).getTime();
            return Number.isNaN(t) ? null : t;
        },
        revive: (v) => new Date(v === null ? NaN : (v as number)),
    },
    {
        name: 'map',
        tag: '$map',
        test: (v) => v instanceof Map,
        serialize: (v) => [...(v as Map<unknown, unknown>).entries()],
        revive: (v) => new Map(v as [unknown, unknown][]),
    },
    {
        name: 'set',
        tag: '$set',
        test: (v) => v instanceof Set,
        serialize: (v) => [...(v as Set<unknown>)],
        revive: (v) => new Set(v as unknown[]),
    },
    {
        name: 'bigint',
        tag: '$bigint',
        test: (v) => typeof v === 'bigint',
        serialize: (v) => (v as bigint).toString(),
        revive: (v) => BigInt(v as string),
    },
    {
        name: 'url',
        tag: '$url',
        test: (v) => typeof URL !== 'undefined' && v instanceof URL,
        serialize: (v) => (v as URL).href,
        revive: (v) => new URL(v as string),
    },
    {
        name: 'regexp',
        tag: '$regexp',
        test: (v) => v instanceof RegExp,
        serialize: (v) => [(v as RegExp).source, (v as RegExp).flags],
        revive: (v) => {
            const [source, flags] = v as [string, string];
            return new RegExp(source, flags);
        },
    },
    {
        name: 'undefined',
        tag: '$undef',
        // JSON drops undefined properties and turns array holes into null;
        // the tag is what makes an explicit undefined survive either position.
        test: (v) => v === undefined,
        serialize: () => 0,
        revive: () => undefined,
    },
];

/** Registry handlers win over built-ins, so a pack can own e.g. `Date`. */
function chain(handlers: readonly SSRTypeHandler[]): readonly SSRTypeHandler[] {
    return handlers.length === 0
        ? BUILTIN_TYPE_HANDLERS
        : [...handlers, ...BUILTIN_TYPE_HANDLERS];
}

/**
 * Whether an encoded object would be misread as a tagged value on the way back.
 * Conservatively covers ANY single `$`-prefixed key, not just the tags that
 * exist today — data written now must still decode correctly after the
 * vocabulary grows.
 */
function needsEscape(value: Record<string, unknown>): boolean {
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0]!.charCodeAt(0) === 36 /* $ */;
}

/**
 * Walk a value into a JSON-safe tree, applying the handler chain.
 *
 * Handlers see RAW values — the walk visits objects before `toJSON` runs,
 * which is the only reason `Date` is matchable at all (its `toJSON` would
 * otherwise have flattened it to a string first). When no handler owns a
 * value, `toJSON` is honored exactly as `JSON.stringify` would.
 */
export function encodeWithHandlers(
    value: unknown,
    handlers: readonly SSRTypeHandler[] = []
): unknown {
    return encode(value, chain(handlers), new Set(), true);
}

/**
 * `escapeTop` is false only when walking a TAGLESS handler's output: that
 * value is already the handler's own wire form (a serialize-only handler
 * written before tags existed typically returns `{ $date: n }` itself), so
 * wrapping it in `$esc` would corrupt an encoding the handler owns. Nested
 * values are always user data and always escape.
 */
function encode(
    value: unknown,
    handlers: readonly SSRTypeHandler[],
    seen: Set<object>,
    escapeTop: boolean
): unknown {
    for (const h of handlers) {
        if (h.test(value)) {
            const payload = encode(h.serialize(value), handlers, seen, !!h.tag);
            return h.tag ? { [h.tag]: payload } : payload;
        }
    }

    if (value === null || typeof value !== 'object') {
        // Functions and symbols are dropped by JSON.stringify; leave that to it.
        return value;
    }

    // Circular structures stay out of scope — surface JSON's own error rather
    // than blowing the stack.
    if (seen.has(value)) {
        throw new TypeError('Converting circular structure to JSON');
    }

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
        seen.add(value);
        try {
            return encode((toJSON as () => unknown).call(value), handlers, seen, escapeTop);
        } finally {
            seen.delete(value);
        }
    }

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => encode(item, handlers, seen, true));
        }

        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            out[key] = encode((value as Record<string, unknown>)[key], handlers, seen, true);
        }
        return escapeTop && needsEscape(out) ? { [ESCAPE_TAG]: out } : out;
    } finally {
        seen.delete(value);
    }
}

/**
 * Walk a decoded-JSON tree, turning `{ [tag]: payload }` objects back into
 * live values. The inverse of {@link encodeWithHandlers}; safe to call on a
 * tree that was never encoded (it is then a deep copy).
 *
 * An unrecognized `$`-tag is left untouched — data written by a newer
 * vocabulary degrades to its raw shape rather than throwing.
 */
export function reviveWithHandlers(
    value: unknown,
    handlers: readonly SSRTypeHandler[] = []
): unknown {
    return revive(value, chain(handlers));
}

function revive(value: unknown, handlers: readonly SSRTypeHandler[]): unknown {
    if (value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) return value.map((item) => revive(item, handlers));

    const keys = Object.keys(value);
    if (keys.length === 1) {
        const key = keys[0]!;
        const payload = (value as Record<string, unknown>)[key];

        if (key === ESCAPE_TAG) {
            // Unwrap one level, reviving the VALUES but never interpreting the
            // unwrapped object's own key as a tag — that is the whole point of
            // the escape. (`{ $esc: { $date: <encoded Date> } }` is a user
            // object with a "$date" property, not a Date.)
            const inner = payload as Record<string, unknown>;
            const unwrapped: Record<string, unknown> = {};
            for (const k of Object.keys(inner)) unwrapped[k] = revive(inner[k], handlers);
            return unwrapped;
        }

        if (key.charCodeAt(0) === 36 /* $ */) {
            for (const h of handlers) {
                if (h.tag === key && h.revive) {
                    return h.revive(revive(payload, handlers));
                }
            }
            if (__DEV__) {
                console.warn(
                    `[sigx] unknown serializer tag "${key}" — no handler claims it, ` +
                    `so the value is left in its encoded shape. Register a handler ` +
                    `with provideSSRSerializerHandlers, or ignore this if the data ` +
                    `was written by a newer version.`
                );
            }
        }
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) {
        out[key] = revive((value as Record<string, unknown>)[key], handlers);
    }
    return out;
}

/**
 * DI token under which serializer handlers are provided at app level.
 * @internal
 */
export const SSR_SERIALIZER_TOKEN = createToken<SSRTypeHandler[]>('sigx:ssrSerializer');

/**
 * Append serializer handlers on an app context at install time.
 *
 * Accumulating: multiple packs can each contribute handlers; earlier-installed
 * handlers are consulted first, and all of them before the built-in
 * vocabulary. The parameter is structurally typed so packs don't need the
 * AppContext type:
 *
 * ```ts
 * install(app) {
 *     provideSSRSerializerHandlers(app._context, [{
 *         name: 'money', tag: '$money',
 *         test: (v) => v instanceof Money,
 *         serialize: (v) => (v as Money).cents,
 *         revive: (c) => new Money(c as number),
 *     }]);
 * }
 * ```
 */
export function provideSSRSerializerHandlers(
    appContext: { provides: Map<symbol, unknown> },
    handlers: SSRTypeHandler[]
): void {
    const existing = getProvided(appContext.provides, SSR_SERIALIZER_TOKEN);
    setProvided(
        appContext.provides,
        SSR_SERIALIZER_TOKEN,
        existing ? [...existing, ...handlers] : [...handlers]
    );
}
