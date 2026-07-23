/**
 * Canonical-key pattern matching for the §6.3 boundary-refresh gate — a
 * boundary descriptor is admitted when any of its `deps` matches any of
 * the mutation's resolved `invalidates` patterns.
 *
 * DUPLICATED from `@sigx/cache` (packages/cache/src/store.ts) — keep the two
 * in sync (a parity test pins them). Duplication is the deliberate trade:
 * `@sigx/server` takes no dependency on the cache pack, and the semantics
 * MUST be identical so a mutation's one `invalidates` declaration drives
 * client cache invalidation and server boundary refresh with the same
 * meaning.
 *
 * Both call sites match ONE pattern set against MANY keys (a whole entry map
 * on the cache side, every descriptor's deps on this side), so the canonical
 * form of a tuple pattern is computed once with {@link preparePattern} and
 * reused — never re-`JSON.stringify`'d per key (the §6.3 gate cost, #469).
 */

/** A pattern with its canonical form precomputed, ready to test many keys. */
export interface PatternMatcher {
    /** True when `entryKey` matches the prepared pattern. */
    match(entryKey: string): boolean;
}

/**
 * Prepare a pattern for matching against many keys: exact string equality, or
 * — for a tuple prefix — every key whose canonical tuple starts with those
 * elements (`['posts']` matches `'["posts","u1",2]'`). The tuple's
 * `JSON.stringify` runs ONCE here, not once per key tested — the whole point
 * of the split (#469).
 */
export function preparePattern(pattern: string | readonly unknown[]): PatternMatcher {
    if (typeof pattern === 'string') {
        return { match: (entryKey) => entryKey === pattern };
    }
    const canon = JSON.stringify(pattern); // '["posts","u1"]'
    const prefix = canon.slice(0, -1); // '["posts","u1"'
    const boundary = prefix.length;
    return {
        match: (entryKey) =>
            entryKey === canon ||
            (entryKey.startsWith(prefix) &&
                (entryKey[boundary] === ',' || entryKey[boundary] === ']'))
    };
}

/**
 * One-shot match — exact string equality, or a tuple prefix (element-boundary
 * guarded). The parity anchor (packages/server/__tests__/key-match.test.ts)
 * and the shape single-shot callers want; loop callers should
 * {@link preparePattern} once and reuse the matcher instead.
 */
export function keyMatches(entryKey: string, pattern: string | readonly unknown[]): boolean {
    return preparePattern(pattern).match(entryKey);
}
