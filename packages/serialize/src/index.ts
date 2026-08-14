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
 *
 * The string-emitting third walk is `@sigx/serialize/stringify` (#657) — an
 * opt-in subpath, because this entry is size-limited at 1 KB with no ignore
 * list possible. `./shared.ts` holds what all three walks must agree on.
 */

import {
    BUILTIN_TYPE_HANDLERS,
    ESCAPE_TAG,
    MAX_DEPTH,
    PROTO_KEY,
    depthError,
    warnUnencodable,
    type TypeHandler
} from './shared.js';

export { BUILTIN_TYPE_HANDLERS };
export type { TypeHandler };

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
 * Registered (custom) handlers always win over the built-ins — a pack can own
 * e.g. `Date`. The two walks below take the `custom` and `builtin` lists
 * SEPARATELY and consult custom first, rather than merging them into one
 * array per call: that `[...handlers, ...BUILTIN]` merge was an allocation on
 * every top-level encode/revive, and keeping them apart also lets `encode`
 * skip the built-in sweep for JSON-native scalars (#470).
 */

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
 *
 * TOUCHING THIS WALK MEANS TOUCHING `./stringify.ts` TOO (#657). That module
 * emits the same encoding straight to a string, and its contract is
 * BYTE equality with `JSON.stringify(encodeWithHandlers(v, h))` — not
 * "equivalent JSON". `__tests__/stringify.test.ts` is the differential suite
 * holding them together; a semantic change here needs a case added there, or
 * the two walks drift silently and the wire changes under a caller.
 */
export function encodeWithHandlers(
    value: unknown,
    handlers: readonly TypeHandler[] = []
): unknown {
    // A SEPARATE dev walk, not a path argument threaded through `encode`
    // (#565): the encoder is on the request-path budgets, and `__DEV__` is
    // stripped from the prod dist, so this costs production exactly nothing —
    // no extra parameter, no extra branch. Dev pays one bounded second pass
    // for property paths, which is the whole point of it.
    if (__DEV__) warnUnencodable(value, handlers);
    return encode(value, handlers, BUILTIN_TYPE_HANDLERS, new Map(), true, 0);
}

/** In-progress marker in the encode memo: seeing it again IS a cycle. */
const IN_PROGRESS = Symbol();

/** A dropped `__proto__` must be VISIBLE in dev (#560) — the old silent
 *  caller-side filters cost real diagnosis time. */
function warnProtoDropped(): void {
    if (__DEV__) {
        console.warn(
            '[sigx] revive dropped an own "__proto__" key — rebuilding it by ' +
            'assignment would swap the prototype of the revived object ' +
            'instead of creating a property (prototype-pollution guard).'
        );
    }
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
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[],
    seen: Map<object, unknown>,
    escapeTop: boolean,
    depth: number
): unknown {
    if (depth > MAX_DEPTH) throw depthError();
    // Registered handlers are opaque — they may own ANY value, scalars
    // included, and they win over the built-ins, so test them first, always.
    // The `.length` guard skips the loop (and its iterator) in the common
    // no-custom-handlers case; nested nodes hit this per node.
    if (custom.length) {
        for (const h of custom) {
            if (h.test(value)) {
                const payload = encode(h.serialize(value), custom, builtin, seen, !!h.tag, depth + 1);
                return h.tag ? { [h.tag]: payload } : payload;
            }
        }
    }

    const type = typeof value;
    // Fast path (#470): no BUILT-IN handler owns a JSON-native scalar — Date/
    // Map/Set/URL/RegExp are objects, and bigint/undefined are handled by the
    // sweep below — so a string/number/boolean/null skips it entirely. This is
    // the per-leaf cost that dominated encoding a plain payload; a registered
    // handler that claims such a value already returned above.
    if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
        return value;
    }

    // bigint / undefined / object / symbol / function: the built-ins own the
    // first two and the object types.
    for (const h of builtin) {
        if (h.test(value)) {
            const payload = encode(h.serialize(value), custom, builtin, seen, !!h.tag, depth + 1);
            return h.tag ? { [h.tag]: payload } : payload;
        }
    }

    if (value === null || typeof value !== 'object') {
        // symbol | function — dropped by JSON.stringify; leave that to it.
        // (null and the JSON-native scalars already returned above; bigint /
        // undefined were claimed by the built-in sweep.) The inline check,
        // rather than `type`, is also what narrows `value` to `object` below.
        return value;
    }

    // The memo doubles as the cycle guard (#559). IN_PROGRESS on the current
    // path is a circular structure — surface JSON's own error rather than
    // blowing the stack. A COMPLETED entry is a shared subtree (diamond/DAG):
    // reuse its encoding instead of re-walking once per path, which was 2^N
    // work for N levels of two-way sharing. The reused value makes the
    // encoded tree a DAG, which JSON.stringify re-expands identically — the
    // wire text is byte-for-byte what the re-walk produced. Handler-claimed
    // values returned above deliberately stay un-memoized (a Map lookup per
    // Date would tax the hot path); sharing routed through them is bounded
    // by MAX_DEPTH instead.
    const existing = seen.get(value);
    if (existing !== undefined) {
        if (existing === IN_PROGRESS) {
            throw new TypeError('Converting circular structure to JSON');
        }
        return existing;
    }

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    seen.set(value, IN_PROGRESS);
    // No try/finally: a throw aborts the whole encodeWithHandlers call and
    // its Map with it — nothing observes stale entries. Memoize only the
    // escape-INDEPENDENT results (arrays; objects whose encoding needs no
    // `$esc` wrap): a needsEscape object encodes differently per escapeTop,
    // and a toJSON result may, so those delete their entry instead.
    if (typeof toJSON === 'function') {
        const result = encode(
            (toJSON as () => unknown).call(value),
            custom,
            builtin,
            seen,
            escapeTop,
            depth + 1
        );
        seen.delete(value);
        return result;
    }
    if (Array.isArray(value)) {
        const out = value.map((item) => encode(item, custom, builtin, seen, true, depth + 1));
        seen.set(value, out);
        return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        out[key] = encode((value as Record<string, unknown>)[key], custom, builtin, seen, true, depth + 1);
    }
    if (needsEscape(out)) {
        seen.delete(value);
        return escapeTop ? { [ESCAPE_TAG]: out } : out;
    }
    seen.set(value, out);
    return out;
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
    return revive(value, handlers, BUILTIN_TYPE_HANDLERS, 0) as T;
}

function revive(
    value: unknown,
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[],
    depth: number
): unknown {
    // The cap matters MOST here (#559): revive runs on attacker-typable wire
    // JSON before anything vets it, and `JSON.parse` (not recursive) happily
    // hands over a tree far deeper than the stack survives. It also bounds a
    // cyclic LIVE value (the hydration blob mixes in client-written objects),
    // which used to recurse forever — revive keeps no `seen` set because
    // parsed JSON cannot share references.
    if (depth > MAX_DEPTH) throw depthError();
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => revive(item, custom, builtin, depth + 1));

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
            for (const k of Object.keys(inner)) {
                if (k === PROTO_KEY) {
                    warnProtoDropped();
                    continue;
                }
                unwrapped[k] = revive(inner[k], custom, builtin, depth + 1);
            }
            return unwrapped;
        }

        // `$esc` reaching here means a payload the encoder never produced
        // (handled above otherwise) — pass it through silently rather than
        // reporting the codec's own escape marker as an unknown tag.
        if (key.charCodeAt(0) === 36 /* $ */ && key !== ESCAPE_TAG) {
            // Custom handlers win over the built-ins on a shared tag.
            for (const h of custom) {
                if (h.tag === key && h.revive) {
                    return h.revive(revive(payload, custom, builtin, depth + 1));
                }
            }
            for (const h of builtin) {
                if (h.tag === key && h.revive) {
                    return h.revive(revive(payload, custom, builtin, depth + 1));
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
        // #548: `out[key] = …` with the key "__proto__" would not create an
        // own property — it would SET the prototype of the object being
        // built, invisibly (gone from Object.keys, JSON.stringify, and
        // toEqual). The codec sees every boundary at once, so the defense
        // lives here rather than in each caller's pre-filter; only this one
        // key is dangerous in this position — "constructor"/"prototype" are
        // plain own data keys under assignment and pass through (#560).
        if (key === PROTO_KEY) {
            warnProtoDropped();
            continue;
        }
        out[key] = revive((value as Record<string, unknown>)[key], custom, builtin, depth + 1);
    }
    return out;
}
