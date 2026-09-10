/**
 * Key canonicalization + dev guards for `useData`.
 *
 * A key does three jobs at once — reactive trigger, cache/SSR identity, and
 * fetcher input — so identity must be canonical: tuples serialize to
 * CANONICAL JSON (`['user', 7]` → `'["user",7]"`; an object element's keys
 * are sorted, so `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` are one key — #694),
 * which also keeps them disjoint from plain string keys used by other
 * producers in the shared SSR blob (a canonical tuple always starts with `[`).
 *
 * Pure module: no web globals, no blob access (that lives in ./restore.ts).
 */

/** All skip values — including '' so `str && tuple` getters type cleanly. */
export type Falsy = null | undefined | false | '';
/**
 * What a tuple element may be (#694): a JSON primitive, an array of these,
 * or a PLAIN object of these (object keys are sorted for identity, so
 * property order never matters). Not a class instance, `Date`, `Map` —
 * identity is canonical JSON, and those have none.
 */
export type KeyJson =
    | string
    | number
    | boolean
    | null
    | readonly KeyJson[]
    | { readonly [key: string]: KeyJson };
/** Tuple elements are JSON values — identity is canonical (key-sorted) JSON. */
export type KeyTuple = readonly KeyJson[];
export type KeyValue = string | KeyTuple;

/**
 * A server-fn reference usable AS a key (rfc-server §6.2, #452): any
 * callable carrying the build-stamped stable key (`<stableId>/<name>`).
 * Structural — runtime-core never imports `@sigx/server`; the brand is the
 * stamped property. As a key it canonicalizes to the key STRING in place
 * (`useData(getVotes)` → `'["<stableId>/getVotes"]'`), so a mutation's
 * fn-ref `invalidates` pattern matches by tuple prefix.
 */
export interface ServerFnDataRef<A extends KeyTuple = KeyTuple, R = unknown> {
    (...args: A): R | Promise<R>;
    /** Build-stamped stable key (`<stableId>/<name>`). */
    __sigxKey: string;
    /**
     * The per-call options channel a wrapped server function carries
     * (`fn.with({ signal })`); the default fetcher threads the cell's abort
     * signal through it when present. Optional: a hand-built ref without
     * one is called directly.
     */
    with?(options: { signal?: AbortSignal }): (...args: A) => R | Promise<R>;
}

/** Brand check — a function whose `__sigxKey` is a non-empty string. */
export function isServerFnDataRef(value: unknown): value is ServerFnDataRef {
    if (typeof value !== 'function') return false;
    const key = (value as { __sigxKey?: unknown }).__sigxKey;
    return typeof key === 'string' && key !== '';
}

/**
 * The ONE canonical stringify every key identity goes through (#694): the
 * same bytes `JSON.stringify` would produce, except that object keys are
 * emitted in sorted order and a server-fn reference element canonicalizes
 * to its stamped key string. Shared with `@sigx/cache` (via internals);
 * `@sigx/server` keeps a byte-identical copy, pinned by its parity test.
 * No validation here — `resolveKeyResult` guards in dev; in prod an
 * unrepresentable value falls back to `null` the way `JSON.stringify` does.
 * A circular structure throws the same `TypeError` `JSON.stringify` would,
 * never recursing without bound.
 */
export function canonicalKeyJson(value: unknown): string {
    return canonicalize(value, undefined);
}

function canonicalize(value: unknown, seen: Set<object> | undefined): string {
    if (value === null) return 'null';
    if (typeof value !== 'object') {
        if (isServerFnDataRef(value)) return JSON.stringify(value.__sigxKey);
        return JSON.stringify(value) ?? 'null';
    }
    const stack = seen ?? new Set<object>();
    if (stack.has(value)) throw new TypeError('[useData] key contains a circular structure');
    stack.add(value);
    let out: string;
    if (Array.isArray(value)) {
        out = '[';
        for (let i = 0; i < value.length; i++) {
            if (i > 0) out += ',';
            out += canonicalize(value[i], stack);
        }
        out += ']';
    } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        out = '{';
        for (let i = 0; i < keys.length; i++) {
            if (i > 0) out += ',';
            out += JSON.stringify(keys[i]) + ':' + canonicalize(record[keys[i]], stack);
        }
        out += '}';
    }
    stack.delete(value);
    return out;
}

/** A plain object — `Object.prototype` or `null` behind it, nothing else. */
function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
}

/**
 * Dev guard for one key element, recursively (#694): a JSON primitive, a
 * finite number, an array, or a plain object of these. `path` names the
 * offending spot in the message.
 */
function assertKeyElement(el: unknown, path: string, warns?: KeyWarnFlags, seen?: Set<object>): void {
    const t = typeof el;
    if (el === null || t === 'string' || t === 'boolean') return;
    if (t === 'number') {
        if (!Number.isFinite(el as number)) {
            throw new TypeError(
                `[useData] tuple key contains a non-finite number (NaN/±Infinity) at ${path} — it would ` +
                'serialize to `null` and collide with other keys. Guard the key getter instead ' +
                '(return a falsy value to skip the fetch).'
            );
        }
        if (Object.is(el, -0) && warns && !warns.negZero) {
            warns.negZero = true;
            console.warn(`[useData] tuple key contains -0 at ${path} — it canonicalizes to 0.`);
        }
        return;
    }
    if (t === 'function') {
        throw new TypeError(
            `[useData] tuple key contains a function with no build-stamped key (__sigxKey) at ${path} — ` +
            'only a server-fn reference can key a tuple. In tests, stamp the fn manually or use a ' +
            'string/tuple key.'
        );
    }
    if (t !== 'object') {
        throw new TypeError(
            `[useData] tuple key elements must be JSON values (string | number | boolean | null | ` +
            `array | plain object); got ${t} at ${path}.`
        );
    }
    // Cycle guard: a self-referencing object would recurse without bound
    // here and throw the JSON.stringify-style TypeError in canonicalization.
    const stack = seen ?? new Set<object>();
    if (stack.has(el as object)) {
        throw new TypeError(`[useData] tuple key contains a circular structure at ${path}.`);
    }
    stack.add(el as object);
    if (Array.isArray(el)) {
        for (let i = 0; i < el.length; i++) assertKeyElement(el[i], `${path}[${i}]`, warns, stack);
        stack.delete(el as object);
        return;
    }
    if (!isPlainObject(el as object)) {
        const name = (el as object).constructor?.name ?? 'object';
        throw new TypeError(
            `[useData] tuple key contains a ${name} at ${path} — identity is canonical JSON, and only a ` +
            'PLAIN object has one. Pass its JSON shape (a Date as its ISO string, a Map as ' +
            'entries) instead.'
        );
    }
    for (const key of Object.keys(el as object)) {
        // Bracket notation with a quoted key: JSON keys may carry dots,
        // brackets or spaces, and `path.key` would read ambiguously.
        assertKeyElement((el as Record<string, unknown>)[key], `${path}[${JSON.stringify(key)}]`, warns, stack);
    }
    stack.delete(el as object);
}

/** Per-cell dedup flags for the soft key warnings (warn once per cell). */
export interface KeyWarnFlags {
    emptyString?: boolean;
    emptyTuple?: boolean;
    negZero?: boolean;
}

/**
 * Resolve a key result to its canonical string identity, or `null` when the
 * read should be skipped (state `'idle'`, fetcher not run).
 *
 * Dev guards (stripped in production):
 * - `''` ⇒ skip + warn (almost always an interpolation bug)
 * - empty tuple ⇒ skip + warn
 * - a non-JSON element (a function without a stamped key, a class instance,
 *   a `Date`, `undefined`, a `bigint`) anywhere in the tuple ⇒ throw
 * - non-finite number ⇒ throw (NaN/±Infinity JSON to `null` — identity collision)
 * - `-0` ⇒ warn (canonicalizes to `0`)
 */
export function resolveKeyResult(raw: KeyValue | Falsy, warns?: KeyWarnFlags): string | null {
    if (raw === null || raw === undefined || raw === false) return null;

    if (raw === '') {
        if (__DEV__ && warns && !warns.emptyString) {
            warns.emptyString = true;
            console.warn(
                '[useData] key resolved to an empty string — treated as a skip (state \'idle\'). ' +
                'If this is unintentional, check the key expression for an interpolation bug.'
            );
        }
        return null;
    }

    if (typeof raw === 'string') return raw;

    if (Array.isArray(raw)) {
        if (raw.length === 0) {
            if (__DEV__ && warns && !warns.emptyTuple) {
                warns.emptyTuple = true;
                console.warn(
                    '[useData] key resolved to an empty tuple — treated as a skip (state \'idle\').'
                );
            }
            return null;
        }
        // Server-fn references canonicalize to their stable-key string in
        // place (#452) — `canonicalKeyJson` does that in prod too; the raw
        // tuple (fn included) is untouched, it stays the fetcher's argument.
        if (__DEV__) {
            for (let i = 0; i < raw.length; i++) {
                const el: unknown = raw[i];
                if (isServerFnDataRef(el)) continue;
                assertKeyElement(el, `[${i}]`, warns);
            }
        }
        return canonicalKeyJson(raw);
    }

    // Not representable as a key — a type error at the call site.
    if (__DEV__) {
        throw new TypeError(`[useData] key must resolve to a string or a tuple; got ${typeof raw}.`);
    }
    return String(raw);
}

/**
 * Classify `useData`'s first argument. A static tuple is rejected by design:
 * a tuple exists to carry parameters, and parameters that change belong in a
 * reactive getter — a static tuple can never change.
 */
export function assertKeyArgShape(first: unknown): 'static' | 'getter' {
    if (typeof first === 'string') return 'static';
    if (typeof first === 'function') return 'getter';
    if (__DEV__) {
        if (Array.isArray(first)) {
            throw new TypeError(
                "[useData] a tuple key must be a getter: useData(() => ['user', id.value] as const, fetcher). " +
                'A static tuple can never change — its parameters belong in a reactive getter.'
            );
        }
        throw new TypeError('[useData] key must be a string or a getter function.');
    }
    throw new TypeError('[useData] invalid key');
}
