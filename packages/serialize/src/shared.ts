/**
 * The vocabulary both walks share.
 *
 * `@sigx/serialize` emits its JSON two ways — `encodeWithHandlers` builds a
 * JSON-safe TREE (`./index.ts`), `stringifyWithHandlers` emits the STRING in
 * one pass (`./stringify.ts`) — and they must agree byte for byte. Anything
 * that would drift if it existed twice lives here, defined once: the handler
 * shape, the built-in tags, the escape marker, the depth ceiling, the
 * `__proto__` key, and the dev-only unencodable probe.
 *
 * Not in the exports map. It is an internal module, hoisted by the bundler
 * into a chunk both entries import; consumers reach every public name through
 * `@sigx/serialize` (which re-exports `TypeHandler` and
 * `BUILTIN_TYPE_HANDLERS`) or `@sigx/serialize/stringify`.
 */

/**
 * One pluggable codec entry for a type JSON cannot represent.
 *
 * Generic over the handled type and its wire form — author handlers with
 * `defineTypeHandler` to get both inferred from the `test` guard. The
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
     * `defineTypeHandler`'s parameter, where it drives inference.
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
 * Marks a plain object that would otherwise be mistaken for a tagged value —
 * a user object shaped `{ $date: … }` is emitted as `{ $esc: { $date: … } }`
 * and unwrapped on revive without interpreting the inner key.
 */
export const ESCAPE_TAG = '$esc';

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

/**
 * Recursion ceiling for encode, stringify AND revive (#559). All three are
 * plainly recursive while `JSON.parse`/`JSON.stringify` are not, so without a
 * cap a deeply nested value — attacker-typable on the request side, where
 * ~1 MiB of `[[[[…` spells hundreds of thousands of levels — overflows the
 * stack. 256 bounds the work long before the engine is in danger while
 * towering over anything legitimate (the deepest bench fixture is 12;
 * boundary records nest single digits before user data starts; a handler
 * chain like Map-of-Set-of-custom consumes a handful of levels per link).
 */
export const MAX_DEPTH = 256;

/** One shared message for every walk — this string ships in the
 *  size-limited client stub bundle, so they all split the cost. */
export const depthError = (): TypeError => new TypeError('nests deeper than 256 levels');

/**
 * The one key JS object machinery interprets in a position this codec writes
 * to. Encode's `out[key] = …` runs the prototype SETTER for it instead of
 * creating an own property; revive drops it outright.
 */
export const PROTO_KEY = '__proto__';

/** Node budget for the dev walk — a huge payload must not stall a dev server. */
const DEV_WALK_BUDGET = 5_000;

/**
 * Dev-only: report values this codec cannot carry, by property path, BEFORE
 * the encoder silently flattens them (#565).
 *
 * Every shape below encodes to something that looks like data and is not:
 * these are lossy SUCCESSES, so nothing else in the stack can notice them.
 *
 * A circular structure is deliberately NOT reported here, even though a
 * property path would be nice: it already throws, which is a signal, and
 * callers that encode speculatively to decide admissibility
 * (`admitPayloadEntry` in `@sigx/server-renderer`) catch that throw and report
 * their own better-scoped message. Warning from inside the probe would
 * double-report the one failure that was never silent.
 *
 * Anything a registered or built-in handler claims is skipped, so an app that
 * registered `Uint8Array` (or `Money`) hears nothing about it — the check
 * consults the same handler chain the encoder does, and cannot drift from it.
 *
 * BOTH entry points run this, and a value routed through either must warn
 * identically — `__tests__/stringify.test.ts` asserts the two call lists are
 * deep-equal, not merely both non-empty.
 */
export function warnUnencodable(root: unknown, custom: readonly TypeHandler[]): void {
    const findings: string[] = [];
    const path: string[] = [];
    const seen = new Set<object>();
    let budget = DEV_WALK_BUDGET;

    const at = (): string => (path.length === 0 ? 'the value' : `\`${path.join('')}\``);

    const walk = (value: unknown, depth: number): void => {
        if (budget-- <= 0 || findings.length >= 3 || depth > MAX_DEPTH) return;
        for (const h of custom) if (h.test(value)) return;
        for (const h of BUILTIN_TYPE_HANDLERS) if (h.test(value)) return;

        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                findings.push(`${at()} is ${String(value)} — it encodes as null`);
            }
            return;
        }
        if (value === null || typeof value !== 'object') return;
        // A cycle stops the walk (it must), but says nothing — see the header.
        if (seen.has(value)) return;
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            findings.push(
                `${at()} is ${(value as object).constructor?.name ?? 'binary'} — it encodes as ` +
                `a plain object of indices, not binary (opt-in handler: @sigx/serialize/bytes)`
            );
            return;
        }
        if (value instanceof Error) {
            findings.push(`${at()} is an Error — its message and stack are not own enumerable properties, so it encodes as {}`);
            return;
        }
        if (value instanceof Promise) {
            findings.push(`${at()} is a Promise — it encodes as {} (a missing await?)`);
            return;
        }
        if (value instanceof WeakMap || value instanceof WeakSet) {
            findings.push(`${at()} is a ${value.constructor.name} — its contents are unreachable, so it encodes as {}`);
            return;
        }
        if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return;

        const proto = Object.getPrototypeOf(value) as object | null;
        if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
            findings.push(
                `${at()} is a ${(value as object).constructor?.name ?? 'class'} instance — it ` +
                `encodes as a plain object and comes back WITHOUT its prototype`
            );
            // Keep walking: its fields may hold worse.
        }

        seen.add(value);
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                path.push(`[${i}]`);
                walk(value[i], depth + 1);
                path.pop();
            }
        } else {
            for (const key of Object.keys(value)) {
                path.push(path.length === 0 ? key : `.${key}`);
                walk((value as Record<string, unknown>)[key], depth + 1);
                path.pop();
            }
        }
        seen.delete(value);
    };

    walk(root, 0);
    if (findings.length === 0) return;
    console.warn(
        '[sigx] this value contains things the boundary codec cannot carry:\n' +
        findings.map((f) => `  • ${f}`).join('\n') +
        '\nRegister a type handler for them (serverPlugin({ types }) / ' +
        'provideTypeHandlers / registerWireTypeHandlers), or convert before ' +
        'returning. Dev-only check; the value itself is unaffected.'
    );
}
