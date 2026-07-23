/**
 * `@sigx/serialize` — the boundary codec.
 *
 * How non-JSON values (Date, Map, Set, BigInt, custom classes, …) survive
 * every boundary sigx moves data across. Both halves run on BOTH sides:
 *
 *              encode                          revive
 *   server     SSR state blob,                 RPC arguments
 *              RPC response, stream chunks
 *   client     RPC arguments                   RPC result, SSR restore,
 *                                              resume boundary props,
 *                                              cache seed
 *
 * That symmetry is why this is its own package rather than living in
 * `@sigx/server` (three of its consumers must never depend on the RPC layer),
 * in `@sigx/server-renderer` (the revive half runs in the browser, often with
 * no renderer present), or in `@sigx/runtime-core` (a codec is not the
 * component model).
 *
 * ZERO dependencies, deliberately: `@sigx/server/client` — the fetch stubs
 * the server-fn transform emits imports of — is dependency-free by contract
 * and imports this module directly, so anything added here lands in a
 * size-limited entry that resume handler chunks replicate.
 *
 * The DI glue that lets a pack register handlers per app
 * (`provideTypeHandlers`) lives in `@sigx/runtime-core`, since it needs that
 * package's `createToken`. This module stays a pure pair of functions.
 */

/**
 * One pluggable codec entry for a type JSON cannot represent.
 *
 * Generic over the handled type and its wire form — author handlers with
 * {@link defineTypeHandler} to get both inferred from the `test` guard. The
 * members are METHOD-declared on purpose: strictFunctionTypes exempts method
 * declarations from contravariant parameter checks, which is what lets a
 * `TypeHandler<Date, number>` flow into the `readonly TypeHandler[]` chains
 * every consumer takes. Bare `TypeHandler` (= `TypeHandler<unknown, unknown>`)
 * is exactly the pre-generic shape, so existing handlers compile unchanged.
 */
export interface TypeHandler<T = unknown, Encoded = unknown> {
    /** Identifies the handler (dev warnings, dedupe by consumers). */
    name: string;
    /**
     * Wire discriminator, e.g. `'$date'`. Encoded values take the single-key
     * form `{ [tag]: payload }` — that shape is what lets the revive half
     * find them again.
     *
     * Optional only for backward compatibility with serialize-only handlers
     * written before the revive half existed; such a handler's output is
     * emitted as-is and never revived.
     */
    tag?: string;
    /**
     * Whether this handler owns the value. Receives the RAW value (before any
     * toJSON). Deliberately `boolean`, not a type predicate — a predicate
     * member would reject every boolean-returning test; the predicate lives on
     * {@link defineTypeHandler}'s parameter, where it drives inference.
     */
    test(value: unknown): boolean;
    /**
     * Return a JSON-safe payload. The result is wrapped as `{ [tag]: payload }`
     * when `tag` is set, and is itself walked — so a handler may return values
     * other handlers own (a `Map`'s entries containing `Date`s, say).
     */
    serialize(value: T): Encoded;
    /** Turn a payload produced by `serialize` back into the live value. */
    revive?(encoded: Encoded): T;
}

/**
 * Author a typed handler without casts: declare `test` as a type guard
 * (`(v): v is Money => v instanceof Money`) and `serialize`/`revive` infer
 * their parameter and pairing from it.
 *
 * ```ts
 * const moneyHandler = defineTypeHandler({
 *     name: 'money',
 *     tag: '$money',
 *     test: (v): v is Money => v instanceof Money,
 *     serialize: (m) => m.cents,          // m: Money
 *     revive: (cents) => new Money(cents) // cents: number (from serialize)
 * });
 * ```
 *
 * Inference caveat: TypeScript only infers a predicate from a bare
 * `instanceof`/`typeof` arrow — a compound test
 * (`(v) => hasDom && v instanceof URL`) infers `boolean` and collapses `T`
 * to `unknown`, so annotate those explicitly (`(v): v is URL => …`).
 *
 * Runtime-wise this is the identity function; it exists purely so the guard
 * can drive inference, which the {@link TypeHandler} interface itself cannot
 * do without breaking boolean-returning tests.
 */
export function defineTypeHandler<T, Encoded = unknown>(handler: {
    name: string;
    tag?: string;
    test(value: unknown): value is T;
    serialize(value: T): Encoded;
    revive?(encoded: Encoded): T;
}): TypeHandler<T, Encoded> {
    return handler;
}

/**
 * Marks a plain object that would otherwise be mistaken for a tagged value —
 * a user object shaped `{ $date: … }` is emitted as `{ $esc: { $date: … } }`
 * and unwrapped on revive without interpreting the inner key.
 */
const ESCAPE_TAG = '$esc';

/** The zero-config vocabulary. Consulted after any registered handlers. */
export const BUILTIN_TYPE_HANDLERS: readonly TypeHandler[] = [
    {
        name: 'date',
        tag: '$date',
        test: (v) => v instanceof Date,
        // NaN is not representable in JSON; null round-trips to Invalid Date.
        serialize: (v) => {
            const t = v.getTime();
            return Number.isNaN(t) ? null : t;
        },
        revive: (v) => new Date(v === null ? NaN : v),
    } satisfies TypeHandler<Date, number | null>,
    {
        name: 'map',
        tag: '$map',
        test: (v) => v instanceof Map,
        serialize: (v) => [...v.entries()],
        revive: (v) => new Map(v),
    } satisfies TypeHandler<Map<unknown, unknown>, [unknown, unknown][]>,
    {
        name: 'set',
        tag: '$set',
        test: (v) => v instanceof Set,
        serialize: (v) => [...v],
        revive: (v) => new Set(v),
    } satisfies TypeHandler<Set<unknown>, unknown[]>,
    {
        name: 'bigint',
        tag: '$bigint',
        test: (v) => typeof v === 'bigint',
        serialize: (v) => v.toString(),
        revive: (v) => BigInt(v),
    } satisfies TypeHandler<bigint, string>,
    {
        name: 'url',
        tag: '$url',
        test: (v) => typeof URL !== 'undefined' && v instanceof URL,
        serialize: (v) => v.href,
        revive: (v) => new URL(v),
    } satisfies TypeHandler<URL, string>,
    {
        name: 'regexp',
        tag: '$regexp',
        test: (v) => v instanceof RegExp,
        serialize: (v) => [v.source, v.flags],
        revive: ([source, flags]) => new RegExp(source, flags),
    } satisfies TypeHandler<RegExp, [string, string]>,
    {
        name: 'undefined',
        tag: '$undef',
        // JSON drops undefined properties and turns array holes into null;
        // the tag is what makes an explicit undefined survive either position.
        test: (v) => v === undefined,
        serialize: () => 0,
        revive: () => undefined,
    } satisfies TypeHandler<undefined, number>,
];

/** Registered handlers win over built-ins, so a pack can own e.g. `Date`. */
function chain(handlers: readonly TypeHandler[]): readonly TypeHandler[] {
    return handlers.length === 0
        ? BUILTIN_TYPE_HANDLERS
        : [...handlers, ...BUILTIN_TYPE_HANDLERS];
}

/**
 * Whether an encoded object would be misread as a tagged value on the way
 * back. Conservatively covers ANY single `$`-prefixed key, not just the tags
 * that exist today — data written now must still decode correctly after the
 * vocabulary grows.
 */
function needsEscape(encoded: Record<string, unknown>): boolean {
    const keys = Object.keys(encoded);
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
    handlers: readonly TypeHandler[] = []
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
    handlers: readonly TypeHandler[],
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
    seen.add(value);
    try {
        if (typeof toJSON === 'function') {
            return encode((toJSON as () => unknown).call(value), handlers, seen, escapeTop);
        }
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
 * live values — the inverse of {@link encodeWithHandlers}.
 *
 * Apply this ONLY to trees that {@link encodeWithHandlers} produced. It is
 * not a general-purpose deep copy: by design it interprets any single-key
 * `$`-prefixed object as a tag, so foreign JSON that happens to contain
 * `{ "$date": 1 }` would come back a `Date`. Encoded trees are safe because
 * the encoder escapes exactly those shapes.
 *
 * An unrecognized `$`-tag is left untouched — data written by a newer
 * vocabulary degrades to its raw shape rather than throwing, which is why the
 * format needs no version field.
 *
 * The type parameter is an ASSERTION, not a validation — it types the result
 * for call sites that know what the tree encodes (`reviveWithHandlers<Cart>`);
 * nothing checks the wire data against it. Omitted, the result is `unknown`.
 */
export function reviveWithHandlers<T = unknown>(
    value: unknown,
    handlers: readonly TypeHandler[] = []
): T {
    return revive(value, chain(handlers)) as T;
}

function revive(value: unknown, handlers: readonly TypeHandler[]): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => revive(item, handlers));

    // Only walk what JSON.parse can actually produce. Anything else is
    // already a live value — a Date, Map, Set, or class instance — and
    // rebuilding it from its own enumerable keys would flatten it to `{}`
    // (Object.keys(new Date()) is []). Returning it untouched is what makes
    // revive IDEMPOTENT, which matters because the hydration blob mixes
    // server-encoded values with live ones written back after client fetches.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const keys = Object.keys(value);
    if (keys.length === 1) {
        const key = keys[0]!;
        const payload = (value as Record<string, unknown>)[key];

        // Only unwrap a payload this codec could actually have produced: the
        // encoder always wraps an OBJECT. A `{ $esc: 1 }` that was never
        // encoded falls through to the generic walk below and survives as
        // itself, rather than becoming `{}` via `Object.keys(1)`.
        if (
            key === ESCAPE_TAG &&
            payload !== null &&
            typeof payload === 'object' &&
            !Array.isArray(payload)
        ) {
            // Unwrap one level, reviving the VALUES but never interpreting the
            // unwrapped object's own key as a tag — that is the whole point of
            // the escape. (`{ $esc: { $date: <encoded Date> } }` is a user
            // object with a "$date" property, not a Date.)
            const inner = payload as Record<string, unknown>;
            const unwrapped: Record<string, unknown> = {};
            for (const k of Object.keys(inner)) unwrapped[k] = revive(inner[k], handlers);
            return unwrapped;
        }

        // `$esc` reaching here means a payload the encoder never produced
        // (handled above otherwise) — pass it through silently rather than
        // reporting the codec's own escape marker as an unknown tag.
        if (key.charCodeAt(0) === 36 /* $ */ && key !== ESCAPE_TAG) {
            for (const h of handlers) {
                if (h.tag === key && h.revive) {
                    return h.revive(revive(payload, handlers));
                }
            }
            if (__DEV__) {
                console.warn(
                    `[sigx] unknown serializer tag "${key}" — no handler claims it, ` +
                    `so the value is left in its encoded shape. Register a handler ` +
                    `with provideTypeHandlers, or ignore this if the data was ` +
                    `written by a newer version.`
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
