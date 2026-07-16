/**
 * Key canonicalization + dev guards for `useData`.
 *
 * A key does three jobs at once — reactive trigger, cache/SSR identity, and
 * fetcher input — so identity must be canonical: tuples serialize to JSON
 * (`['user', 7]` → `'["user",7]"`), which also keeps them disjoint from
 * plain string keys used by other producers in the shared SSR blob (a
 * canonical tuple always starts with `[`).
 *
 * Pure module: no web globals, no blob access (that lives in ./restore.ts).
 */

/** All skip values — including '' so `str && tuple` getters type cleanly. */
export type Falsy = null | undefined | false | '';
/** Tuple elements are JSON primitives only — identity is canonical JSON. */
export type KeyTuple = readonly (string | number | boolean | null)[];
export type KeyValue = string | KeyTuple;

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
 * - non-primitive tuple element ⇒ throw
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
        if (__DEV__) {
            for (const el of raw) {
                const t = typeof el;
                if (el !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
                    throw new TypeError(
                        `[useData] tuple key elements must be JSON primitives (string | number | boolean | null); got ${t}.`
                    );
                }
                if (t === 'number' && !Number.isFinite(el as number)) {
                    throw new TypeError(
                        '[useData] tuple key contains a non-finite number (NaN/±Infinity) — it would ' +
                        'serialize to `null` and collide with other keys. Guard the key getter instead ' +
                        '(return a falsy value to skip the fetch).'
                    );
                }
                if (Object.is(el, -0) && warns && !warns.negZero) {
                    warns.negZero = true;
                    console.warn('[useData] tuple key contains -0 — it canonicalizes to 0.');
                }
            }
        }
        return JSON.stringify(raw);
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
