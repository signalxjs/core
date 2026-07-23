/**
 * Canonical-key pattern matching for the §6.3 boundary-refresh gate — a
 * boundary descriptor is admitted when any of its `deps` matches any of
 * the mutation's resolved `invalidates` patterns.
 *
 * DUPLICATED from `@sigx/cache`'s `keyMatches` (packages/cache/src/store.ts)
 * — keep the two in sync (a parity test pins them). Duplication is the
 * deliberate trade: `@sigx/server` takes no dependency on the cache pack,
 * and the semantics MUST be identical so a mutation's one `invalidates`
 * declaration drives client cache invalidation and server boundary refresh
 * with the same meaning.
 */

/**
 * Exact string equality, or — when the pattern is a tuple prefix — every
 * entry whose canonical tuple starts with those elements (`['posts']`
 * matches `'["posts","u1",2]'`).
 */
export function keyMatches(entryKey: string, pattern: string | readonly unknown[]): boolean {
    if (typeof pattern === 'string') return entryKey === pattern;
    const canon = JSON.stringify(pattern); // '["posts","u1"]'
    if (entryKey === canon) return true;
    const prefix = canon.slice(0, -1); // '["posts","u1"'
    return entryKey.startsWith(prefix) && (entryKey[prefix.length] === ',' || entryKey[prefix.length] === ']');
}
