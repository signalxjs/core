/**
 * Canonical-key pattern matching — what an `invalidates` declaration MEANS.
 *
 * One declaration drives three consumers: client cache invalidation
 * (`@sigx/cache`), the §6.3 boundary-refresh gate (`@sigx/server`), and
 * key-addressable refresh of mounted `useData` cells ({@link invalidateKeys},
 * next to this file). They must agree exactly, or the same mutation refreshes
 * different things depending on which packs an app installed.
 *
 * This is the canonical implementation. `@sigx/cache` imports it. `@sigx/server`
 * deliberately keeps its own copy (`packages/server/src/server/key-match.ts`) —
 * that package takes no dependency on runtime-core, and a parity test
 * (`packages/server/__tests__/key-match.test.ts`) pins the two together.
 *
 * Every call site matches ONE pattern set against MANY keys, so the canonical
 * form of a tuple pattern is computed once with {@link preparePattern} and
 * reused — never re-`JSON.stringify`'d per key tested (#469).
 */

/** A pattern with its canonical form precomputed, ready to test many keys. */
export interface PatternMatcher {
    /** True when `entryKey` matches the prepared pattern. */
    match(entryKey: string): boolean;
}

/**
 * Prepare a pattern for matching against many keys: exact string equality, or
 * — for a tuple prefix — every key whose canonical tuple starts with those
 * elements (`['posts']` matches `'["posts","u1",2]'`). The element-boundary
 * check is what keeps `['post']` from matching `'["posts"]'`.
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
 * guarded). Loop callers should {@link preparePattern} once and reuse the
 * matcher instead.
 */
export function keyMatches(entryKey: string, pattern: string | readonly unknown[]): boolean {
    return preparePattern(pattern).match(entryKey);
}
