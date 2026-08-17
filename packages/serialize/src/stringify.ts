/**
 * `stringifyWithHandlers` — the boundary codec's JSON in ONE walk (#657).
 *
 * Byte-for-byte `JSON.stringify(encodeWithHandlers(value, handlers))`, with
 * the intermediate tree never built. That tree is pure garbage: every emitter
 * throws it away one statement later, and `@sigx/server-renderer`'s
 * `isSerializable` builds a whole second one just to ask whether stringify
 * would throw. Storage adapters pay the same twice — a durable actor save
 * encodes the state and then `JSON.stringify`s the result, because what the
 * store wants is a string (signalxjs/actors#227 measured that second walk at
 * +51% on top of the encode).
 *
 * OPT-IN SUBPATH, by budget: the root entry is size-limited at 1 KB with no
 * ignore list possible — `@sigx/server/client` imports it, and that entry is
 * itself the "stubs drag no runtime" guard — so this walk cannot live there.
 * Same shape as `@sigx/serialize/bytes` (#569): its own entry, its own size
 * row, and the untouched root row proving that not importing it costs zero.
 *
 * PARITY IS THE CONTRACT, not "what JSON.stringify would do". The codec
 * already diverges from raw JSON in ways callers depend on — a boxed
 * `new Number(5)` encodes to `{}`, not `5`; `{ $a: … }` gains a `$esc` wrap;
 * `toJSON` is called with NO arguments. `__tests__/stringify.test.ts` is a
 * differential suite against `JSON.stringify(encodeWithHandlers(…))`; if the
 * two walks ever disagree, THAT is the bug, whichever one looks nicer.
 *
 * GRANULARITY: the pure-JSON fast path fires per RUN, not just per node
 * (#666) — consecutive array elements that are scalars, scalar-valued plain
 * rows, or rows whose only codec hits are built-in scalar-payload leaves go
 * to the native serializer as one batch (`batchable` below). Per-node native
 * calls made a 500-row collection LOSE to the two-walk pair it replaced.
 *
 * One acknowledged non-parity, out of scope by design: `encode` builds its
 * objects with `out[key] = …`, so an own `__proto__` key holding an
 * object-valued payload SETS the prototype of the encoded node. That is
 * invisible to `JSON.stringify` (own enumerable keys only) unless the payload
 * carries a callable `toJSON`, which requires a custom handler whose `tag` is
 * literally `"toJSON"`. This walk never builds an object, so it never
 * inherits one. Tags are `$`-prefixed by convention; do not name one
 * `toJSON`.
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

export type { TypeHandler };

/**
 * The characters `JSON.stringify` escapes, and EXACTLY those: C0 controls
 * (U+0000–U+001F), the quote, the backslash, and every surrogate code unit
 * (U+D800–U+DFFF — the well-formed-stringify lone-surrogate rule from
 * ES2019). U+007F, U+2028, U+2029 and every astral character are emitted
 * LITERALLY, so the fast path must leave them alone. (U+2028/U+2029 are
 * escaped later, and only for `<script>` embedding, by `escapeJsonForScript`
 * in `@sigx/server-renderer`. Doing it here would change wire bytes.)
 *
 * No `u` flag: the pattern contains bare surrogate ranges, which a Unicode
 * regex rejects.
 *
 * The surrogate half deliberately OVER-triggers — a well-formed pair needs no
 * escaping, so one emoji sends the whole string down the slow path for
 * nothing. That is the right trade: the slow path is native `JSON.stringify`,
 * correct by definition, and lone-surrogate handling is precisely where a
 * hand-rolled escaper gets it wrong.
 */
// Matching control characters is the entire purpose of this pattern — they are
// exactly what has to be routed to the slow path.
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\x00-\x1f\uD800-\uDFFF]/;

/** `"` + s + `"` when nothing needs escaping — the overwhelming case for
 *  object keys and for the short strings a state blob is made of. */
function quote(s: string): string {
    return NEEDS_ESCAPE.test(s) ? JSON.stringify(s) : `"${s}"`;
}

/** Derived, never re-spelled, so `$esc` has ONE definition (`./shared.ts`). */
const ESC_OPEN = `{"${ESCAPE_TAG}":`;

/** In-progress marker in the memo: seeing it again IS a cycle. Private to
 *  this walk — the two walks never share a Map, so hoisting the symbol into
 *  `shared.ts` would be a byte on the root's chunk for nothing. */
const IN_PROGRESS = Symbol();

/**
 * "Let JSON do it." Whether every own value of this node is a JSON-NATIVE
 * SCALAR that no registered handler claims — in which case the node encodes
 * to ITSELF, and the whole thing can go to the native serializer in one C++
 * call instead of being emitted key by key in JS.
 *
 * This is what keeps the fused walk honest on plain payloads. Emitting by
 * hand beats building an intermediate tree only when the codec actually does
 * work; for a thousand flat rows of strings and numbers there is no tree
 * worth avoiding, and hand-rolled JS emission is about twice the cost of
 * `JSON.stringify`. Measured on the `plainList` fixture, this path is the
 * difference between losing ~10% to the two-walk version and beating it.
 *
 * Rejects — falling back to the manual walk — on anything the codec would
 * treat differently from raw JSON:
 * - a non-scalar value (a Date, a Map, a nested object, a bigint): the
 *   vocabulary owns it, or it needs its own walk;
 * - `undefined`, a symbol or a function: JSON drops them, the codec tags or
 *   counts them (`$undef`, and the `$esc` key count);
 * - an own `__proto__` key: native emits it, `encode`'s `out[key] =` swallows
 *   it;
 * - a value a REGISTERED handler claims, scalars included — the test costs
 *   exactly what the manual walk would have spent on it anyway.
 *
 * `NaN`/`Infinity` do NOT reject: both paths write `null` for them.
 *
 * One divergence, accepted and documented: a value is read once here and
 * again by `JSON.stringify`, so a side-effecting GETTER is evaluated twice
 * where `encode` evaluates it once. A getter that returns a different value
 * per read is not serializable in any meaningful sense; a deterministic one
 * is unaffected.
 */
function pureScalars1(v: unknown, custom: readonly TypeHandler[]): boolean {
    const t = typeof v;
    if (!(v === null || t === 'string' || t === 'number' || t === 'boolean')) return false;
    if (custom.length) {
        for (const h of custom) if (h.test(v)) return false;
    }
    return true;
}

/** The same test across an array's elements. */
function pureScalars(values: readonly unknown[], custom: readonly TypeHandler[]): boolean {
    for (let i = 0; i < values.length; i++) {
        if (!pureScalars1(values[i], custom)) return false;
    }
    return true;
}

/** Run-batching sentinel (#666): this element cannot ride a native batch —
 *  emit it via the manual walk, which is ground truth. */
const REJECT = Symbol();

/**
 * A value the codec's vocabulary claims, pre-encoded for a native batch —
 * `{ [tag]: payload }` — or REJECT.
 *
 * BUILT-INS ONLY, and only those whose payload is a JSON-native scalar (Date,
 * bigint, URL, `undefined`; Map/Set/RegExp payloads are arrays and reject via
 * the payload check). Two reasons, both load-bearing:
 * - a payload is walked through the FULL chain by `encode`, so a custom
 *   handler may claim a built-in's payload (a string equal to a bigint's
 *   digits, say) — hence `pureScalars1(p, custom)` on the payload, not a bare
 *   typeof;
 * - a CUSTOM handler's `serialize` may be impure, and an element whose run is
 *   later broken would have it called here and again by the manual walk.
 *   Every built-in serialize is a pure read, so built-ins cannot observe the
 *   double call. Custom-claimed values therefore break runs instead.
 *
 * The computed key is deliberate: an object LITERAL's computed key is not
 * subject to the `__proto__` setter, exactly like `encode`'s `{ [h.tag]: p }`.
 */
function encodeLeaf(
    v: unknown,
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[]
): unknown {
    if (custom.length) {
        for (const h of custom) if (h.test(v)) return REJECT;
    }
    for (const h of builtin) {
        if (h.test(v)) {
            const p = h.serialize(v);
            // Every built-in is tagged; the `!` records that, not a hope.
            return pureScalars1(p, custom) ? { [h.tag!]: p } : REJECT;
        }
    }
    // symbol | function | an object no vocabulary claims.
    return REJECT;
}

/**
 * Whether an array element can join a NATIVE BATCH (#666): returns the
 * element itself, an order-preserving encoded copy, or REJECT.
 *
 * The per-node fast path made a 500-row collection ~500 separate native
 * `JSON.stringify` calls joined in JS — measurably WORSE than the two-walk
 * pair it replaced (issue #666's table: +2.4% on scalar rows, +7.5% when one
 * `Date` per row disqualified every node). Batching runs of eligible elements
 * into one native call is what makes a big collection of small nodes win the
 * same way one big node already did.
 *
 * Eligible, beyond `pureScalars1`:
 * - a dense-or-holey array of pure scalars (a hole is byte-safe in a batch:
 *   `encode`'s `.map()` skips it and stringify writes `null`, and the
 *   `undefined` the batch buffer carries makes native write `null` too);
 * - a plain-prototype object whose values are pure scalars or
 *   `encodeLeaf`-substitutable leaves — a row `{ id, at: Date }` becomes a
 *   lazy partial COPY `{ id, at: { $date: n } }`, key order preserved, and
 *   rides the batch;
 * - Date / bigint / URL / explicit `undefined` elements directly, via
 *   `encodeLeaf`.
 *
 * Rejects mirror the codec's divergences from raw JSON, each the same reason
 * the per-node fast path rejects it: a sole `$`-prefixed key (needs the
 * `$esc` wrap native won't add), an own `__proto__` key (native emits it,
 * `encode` swallows it), a non-plain prototype (boxed primitives, class
 * instances), a custom-claimed value anywhere. `toJSON` is rejected by an
 * EXPLICIT `typeof` read — an own non-enumerable `toJSON` or a patched
 * `Object.prototype` is invisible to `Object.keys` but honored by both walks,
 * with different signatures. The built-in sweep runs BEFORE the `toJSON`
 * check for non-plain objects, mirroring `str`'s order: a `Date` with a
 * hijacked own `toJSON` is still `$date`.
 *
 * The read-twice note on `pureScalars1` extends here unchanged: a pass-by-ref
 * element is read by this scan and again by the native call — the same
 * accepted getter divergence, on the same nodes, that the per-node fast path
 * already had. A COPIED row's substituted-onward keys are read once.
 *
 * Never consults `seen`: an eligible element has no object-valued members, so
 * it can neither be an IN_PROGRESS ancestor nor close a cycle, and a shared
 * row re-stringified natively is byte-identical to a memo splice.
 */
function batchable(
    v: unknown,
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[]
): unknown {
    if (pureScalars1(v, custom)) return v;
    // bigint / undefined / symbol / function, or a custom-claimed scalar.
    if (v === null || typeof v !== 'object') return encodeLeaf(v, custom, builtin);
    if (custom.length) {
        for (const h of custom) if (h.test(v)) return REJECT;
    }
    if (Array.isArray(v)) {
        if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return REJECT;
        for (let i = 0; i < v.length; i++) {
            const e = v[i];
            // A hole: `null` under both walks, so it stays.
            if (e === undefined && !(i in v)) continue;
            // Scalars only one level down — a substitution here would put its
            // payload past the depth the caller's gate accounts for.
            if (!pureScalars1(e, custom)) return REJECT;
        }
        return v;
    }
    const proto = Object.getPrototypeOf(v);
    // A Date/URL ELEMENT substitutes; a boxed primitive or class instance
    // falls through encodeLeaf unclaimed and rejects.
    if (proto !== Object.prototype && proto !== null) return encodeLeaf(v, custom, builtin);
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return REJECT;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0]!.charCodeAt(0) === 36 /* $ */) return REJECT;
    let copy: Record<string, unknown> | undefined;
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k]!;
        if (key === PROTO_KEY) return REJECT;
        const val = (v as Record<string, unknown>)[key];
        if (pureScalars1(val, custom)) {
            if (copy) copy[key] = val;
            continue;
        }
        const sub = encodeLeaf(val, custom, builtin);
        if (sub === REJECT) return REJECT;
        if (!copy) {
            // Lazy: the overwhelmingly common all-scalar row never allocates.
            // Backfill is safe from the setter — every earlier key already
            // passed the PROTO_KEY check above.
            copy = {};
            for (let j = 0; j < k; j++) {
                const kj = keys[j]!;
                copy[kj] = (v as Record<string, unknown>)[kj];
            }
        }
        copy[key] = sub;
    }
    return copy ?? v;
}

/**
 * The JSON that `encodeWithHandlers` + `JSON.stringify` would have produced,
 * in one pass.
 *
 * Returns `undefined` for exactly what `JSON.stringify` returns `undefined`
 * for: a top-level symbol or function. Nothing else can — a `toJSON` that
 * returns `undefined` comes back as `{"$undef":0}`, because the built-in
 * vocabulary claims it. `isSerializable` in `@sigx/server-renderer` branches
 * on that `undefined`; the signature is honest on purpose.
 *
 * Throws the same two `TypeError`s `encodeWithHandlers` does: a circular
 * structure, and a value nesting past 256 levels.
 */
export function stringifyWithHandlers(
    value: unknown,
    handlers: readonly TypeHandler[] = []
): string | undefined {
    // The same SEPARATE dev walk the tree encoder runs (#565) — not a path
    // argument threaded through the hot walk. `__DEV__` is stripped from the
    // prod dist, so this costs production exactly nothing, and a value routed
    // through THIS entry point must warn identically to one routed through
    // `encodeWithHandlers`.
    if (__DEV__) warnUnencodable(value, handlers);
    return str(value, handlers, BUILTIN_TYPE_HANDLERS, new Map(), true, 0);
}

/**
 * `escapeTop` carries exactly the meaning it has in `encode`: false ONLY when
 * walking a TAGLESS handler's output, which is already the handler's own wire
 * form (a serialize-only handler written before tags existed typically returns
 * `{ $date: n }` itself), so a `$esc` wrap would corrupt an encoding the
 * handler owns. Nested values are always user data and always escape.
 */
function str(
    value: unknown,
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[],
    seen: Map<object, string | symbol>,
    escapeTop: boolean,
    depth: number
): string | undefined {
    if (depth > MAX_DEPTH) throw depthError();

    // Registered handlers are opaque — they may own ANY value, scalars
    // included, and they win over the built-ins, so test them first, always.
    // The `.length` guard skips the loop and its iterator in the common
    // no-custom-handlers case; nested nodes hit this per node.
    if (custom.length) {
        for (const h of custom) {
            if (h.test(value)) return tagged(h, value, custom, builtin, seen, depth);
        }
    }

    // JSON-native scalar fast path, mirroring `encode`'s #470 shortcut — and
    // this is where fusing actually pays: the leaf goes straight to text
    // instead of being copied into a tree for stringify to re-visit.
    const type = typeof value;
    if (value === null) return 'null';
    if (type === 'string') return quote(value as string);
    // JSON has no NaN/Infinity: stringify writes `null`. For finite values
    // stringify IS ToString(Number), so `String(n)` is byte-identical —
    // including `-0` → "0" and `1e21` → "1e+21".
    if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (type === 'boolean') return value ? 'true' : 'false';

    // bigint / undefined / Date / Map / Set / URL / RegExp — the built-ins own
    // the first two and the object types.
    for (const h of builtin) {
        if (h.test(value)) return tagged(h, value, custom, builtin, seen, depth);
    }

    // symbol | function. `encode` returns them as-is and lets `JSON.stringify`
    // drop them; `undefined` is this walk's spelling of that same drop, and
    // each caller below reproduces its own position's rule. (null and the
    // JSON-native scalars returned above; bigint/undefined were claimed by
    // $bigint/$undef in the sweep.)
    if (typeof value !== 'object') return undefined;

    // The memo doubles as the cycle guard (#559). IN_PROGRESS on the current
    // path is a circular structure — surface JSON's own error rather than
    // blowing the stack. A COMPLETED entry is a shared subtree (diamond/DAG)
    // whose TEXT is spliced in verbatim.
    //
    // This is the exact fused analogue of `encode`'s memo, and byte-equivalent
    // by construction: `encode` reuses a node and lets `JSON.stringify`
    // re-expand it identically at every position, so memoizing the expansion
    // itself cannot differ. 40 levels of two-way sharing is 2^40 walks without
    // it — an effective hang (see `__tests__/index.test.ts`). Handler-claimed
    // values stay un-memoized, exactly as in `encode` (a Map lookup per Date
    // would tax the hot path); sharing routed through a handler is bounded by
    // MAX_DEPTH instead, which is also why a cycle THROUGH a handler reports
    // "nests deeper", not "circular".
    const memo = seen.get(value);
    if (memo !== undefined) {
        if (memo === IN_PROGRESS) throw new TypeError('Converting circular structure to JSON');
        return memo as string;
    }

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    seen.set(value, IN_PROGRESS);
    // No try/finally: a throw aborts the whole call and its Map with it —
    // nothing observes stale entries.

    // `toJSON`, honored exactly as `encode` honors it — called with NO
    // arguments. `JSON.stringify` passes the key; this codec never has, and
    // parity is with the codec. NOT memoized, for `encode`'s own reason: a
    // toJSON result may itself be escape-DEPENDENT, so its text is not a
    // function of the node alone.
    if (typeof toJSON === 'function') {
        const out = str((toJSON as () => unknown).call(value), custom, builtin, seen, escapeTop, depth + 1);
        seen.delete(value);
        return out;
    }

    if (Array.isArray(value)) {
        // An array of plain scalars IS its own encoding — see `pureScalars1`.
        // A hole reads as `undefined`, which the scan rejects, so a sparse
        // array always takes the manual path below. `depth < MAX_DEPTH` for
        // the same reason as the object branch: the elements would have been
        // walked one level down, and that is where the cap fires.
        if (depth < MAX_DEPTH && pureScalars(value, custom)) {
            const native = JSON.stringify(value);
            seen.set(value, native);
            return native;
        }

        // The manual walk, run-batched (#666): consecutive `batchable`
        // elements accumulate in a buffer flushed as ONE native call —
        // `JSON.stringify(buf).slice(1, -1)` strips the brackets and the run's
        // internal commas come out native (a run of one is fine: "[5]" → "5").
        // `{ steps: [500 rows] }` is thereby one native call, not 500.
        //
        // The gate is the STRICTEST depth any batched byte can stand for: a
        // substituted row field's tag payload sits at depth+3 (row at d+1,
        // wrapper at d+2, payload at d+3), where `encode` would throw. Near
        // the cap the loop falls back to per-element `str`, which reproduces
        // the throw (or its absence) exactly.
        const canBatch = depth + 2 < MAX_DEPTH;
        let out = '[';
        let first = true;
        let buf: unknown[] | undefined;
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            // Holes are the whole reason this is not a plain indexed read.
            // `encode` walks with `value.map()`, which SKIPS holes, so a
            // sparse array's holes survive into the encoded array and
            // stringify writes `null` for them. Handing the walk the
            // `undefined` a hole reads as would let the `$undef` built-in
            // claim it, and `[1,,3]` would emit `[1,{"$undef":0},3]`.
            //
            // The `in` check is what distinguishes a hole from an EXPLICIT
            // undefined — but only an `undefined` read can be either, so a
            // dense array never pays for it. In a batch the hole rides as the
            // `undefined` it reads as: native writes `null` for it, exactly
            // the byte the codec wants.
            const hole = item === undefined && !(i in value);
            if (canBatch) {
                const rep = hole ? undefined : batchable(item, custom, builtin);
                if (rep !== REJECT) {
                    (buf ??= []).push(rep);
                    continue;
                }
                if (buf !== undefined) {
                    if (!first) out += ',';
                    first = false;
                    out += JSON.stringify(buf).slice(1, -1);
                    buf = undefined;
                }
            }
            // `?? 'null'` covers both drops JSON makes in this position: the
            // hole, and an element that stringifies to nothing (a symbol or a
            // function).
            const text = hole ? undefined : str(item, custom, builtin, seen, true, depth + 1);
            if (!first) out += ',';
            first = false;
            out += text ?? 'null';
        }
        if (buf !== undefined) {
            if (!first) out += ',';
            out += JSON.stringify(buf).slice(1, -1);
        }
        out += ']';
        seen.set(value, out);
        return out;
    }

    // Plain object. The escape decision is taken from the KEY SET, up front,
    // and it has to be — twice over.
    //
    // (a) Semantically: `encode` runs `needsEscape` on the ENCODED object
    //     BEFORE `JSON.stringify` drops symbol- and function-valued keys, so
    //     `{ $a: Symbol() }` emits `{"$esc":{}}` — an empty object wearing an
    //     escape earned by a key that never reached the wire. Deciding from
    //     the surviving text would give `{}`. Encoding never renames a key,
    //     so the encoded key set IS the source key set and the decision needs
    //     no value reads at all.
    // (b) Mechanically: the `{"$esc":` prefix is the first byte written.
    //
    // `__proto__` is excluded from the count for the same reason it never
    // appears in the output: `encode`'s `out[key] = …` for that key runs the
    // prototype SETTER instead of creating an own property, so it is
    // invisible to both `Object.keys(out)` and `JSON.stringify(out)`.
    // The body is accumulated first and wrapped at the end, so the keys are
    // walked ONCE: the escape decision needs a count, not a prefix that has
    // to exist before the first byte.
    const keys = Object.keys(value as object);

    // The pure-JSON fast path — one scan, no allocation. `__proto__` is
    // rejected on its own account (native emits it, `encode` swallows it);
    // everything else is the scalar test in `pureScalars1`.
    //
    // PLAIN objects only. `JSON.stringify` gives a boxed primitive its
    // ToPrimitive value — `new String('ab')` is `"ab"` — while the codec has
    // no special case for it and flattens it to its own keys,
    // `{"0":"a","1":"b"}`. The same prototype test `revive` uses is the cheap
    // way to keep every such object on the manual path; a class instance
    // paying the slow walk is a fine trade for not having to enumerate which
    // built-ins the native serializer treats specially.
    //
    // `depth < MAX_DEPTH` because the scalars would have been walked at
    // `depth + 1`, and that is the level the cap fires on. Emitting them
    // without descending would silently raise the ceiling by one for a node
    // that happens to be plain.
    const proto = Object.getPrototypeOf(value);
    let pure = depth < MAX_DEPTH && (proto === Object.prototype || proto === null);
    for (let k = 0; pure && k < keys.length; k++) {
        const key = keys[k]!;
        if (key === PROTO_KEY || !pureScalars1((value as Record<string, unknown>)[key], custom)) {
            pure = false;
            break;
        }
    }
    if (pure) {
        const native = JSON.stringify(value);
        // The escape rule still applies — a single `$`-prefixed key is a
        // collision whatever its value is — but it wraps the native text
        // instead of replacing it.
        if (keys.length === 1 && keys[0]!.charCodeAt(0) === 36 /* $ */) {
            // Escape-DEPENDENT, so not memoizable; `encode` drops its entry
            // here too.
            seen.delete(value);
            return escapeTop ? `${ESC_OPEN}${native}}` : native;
        }
        seen.set(value, native);
        return native;
    }

    let body = '';
    let liveKeys = 0;
    let soleKey = '';
    let first = true;
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k]!;
        // The `__proto__` VALUE is still walked. `encode` calls `encode` for
        // it and only THEN lets the assignment swallow the key, so a cycle or
        // a depth overflow reachable only through `__proto__` still throws.
        // Skipping the recursion would silently stop throwing.
        const text = str((value as Record<string, unknown>)[key], custom, builtin, seen, true, depth + 1);
        if (key === PROTO_KEY) continue;
        // Counted BEFORE the drop check, because `encode` counts the encoded
        // object's keys and `out[key] = someSymbol` does create the key.
        liveKeys++;
        soleKey = key;
        // A symbol- or function-valued key is OMITTED from an object.
        if (text === undefined) continue;
        if (first) first = false;
        else body += ',';
        // Three appends rather than one template literal: the template builds
        // an intermediate string per key before the concatenation, and a key
        // is the single most repeated allocation in this walk.
        body += quote(key);
        body += ':';
        body += text;
    }

    // `needsEsc` and `wrap` are deliberately separate: `encode` suppresses the
    // memo whenever `needsEscape(out)` holds, INDEPENDENTLY of `escapeTop`.
    // Splitting them keeps this walk auditable line for line against it.
    const needsEsc = liveKeys === 1 && soleKey.charCodeAt(0) === 36 /* $ */;
    const wrap = needsEsc && escapeTop;
    const out = wrap ? `${ESC_OPEN}{${body}}}` : `{${body}}`;

    if (needsEsc) {
        // Escape-DEPENDENT: the text is a function of the node AND escapeTop,
        // so it is not memoizable. `encode` deletes the entry here too.
        seen.delete(value);
        return out;
    }
    seen.set(value, out);
    return out;
}

/**
 * A handler-claimed value: `{ [tag]: payload }` when tagged, the bare payload
 * when not. The payload is walked at `escapeTop = !!tag`, exactly as `encode`
 * does — see `str`'s header for why a tagless payload must not be escaped.
 *
 * Handler-claimed values are never memoized and never marked IN_PROGRESS,
 * matching `encode`; see the memo comment in `str`.
 */
function tagged(
    h: TypeHandler,
    value: unknown,
    custom: readonly TypeHandler[],
    builtin: readonly TypeHandler[],
    seen: Map<object, string | symbol>,
    depth: number
): string | undefined {
    const payload = str(h.serialize(value), custom, builtin, seen, !!h.tag, depth + 1);
    // Tagless: the handler owns the whole encoding, drop and all.
    if (!h.tag) return payload;
    // A payload JSON cannot represent (a symbol or function the handler
    // returned) leaves the WRAPPER behind, empty: `{ $tag: sym }` is what
    // `encode` builds, and `{}` is what `JSON.stringify` writes for it.
    //
    // `quote(h.tag)`, not bare concatenation: a tag is an arbitrary string,
    // and — unlike the plain-object branch above — a computed key in an
    // object literal is NOT subject to the `__proto__` setter, so a handler
    // tagged `"__proto__"` really does emit `{"__proto__":…}`. The two
    // branches are asymmetric on purpose; `encode` is asymmetric the same way.
    return payload === undefined ? '{}' : `{${quote(h.tag)}:${payload}}`;
}
