/**
 * @vitest-environment node
 *
 * `keyMatches` parity (#452): the §6.3 admission gate duplicates
 * `@sigx/cache`'s matcher so `@sigx/server` stays cache-independent — one
 * `invalidates` declaration must mean the same thing on both sides. This
 * table runs identical fixtures through BOTH implementations; if they ever
 * diverge, this is the tripwire.
 *
 * Covers both the one-shot `keyMatches` (the anchor) AND `preparePattern`
 * (#469) — the prepared matcher is what the real call sites actually run, so
 * a divergence there would be a real cache/server split even with `keyMatches`
 * still in agreement.
 */

import { describe, it, expect } from 'vitest';
import { keyMatches as serverMatch, preparePattern as serverPrepare } from '../src/server/key-match';
import { keyMatches as cacheMatch, preparePattern as cachePrepare } from '../../cache/src/store';

const CASES: Array<[entryKey: string, pattern: string | readonly unknown[], expected: boolean]> = [
    // string patterns: exact equality only
    ['poll:votes', 'poll:votes', true],
    ['poll:votes', 'poll', false],
    ['["poll"]', '["poll"]', true],
    // tuple patterns: exact canonical match
    ['["posts","u1"]', ['posts', 'u1'], true],
    // tuple prefix matches — element-boundary guarded
    ['["posts","u1",2]', ['posts'], true],
    ['["posts","u1",2]', ['posts', 'u1'], true],
    ['["postscript"]', ['posts'], false],
    ['["posts2"]', ['posts'], false],
    // fn-derived keys: ["<stableId>#<name>", ...args]
    ['["src/api.server.ts#getVotes"]', ['src/api.server.ts#getVotes'], true],
    ['["src/api.server.ts#getVotes",7]', ['src/api.server.ts#getVotes'], true],
    ['["src/api.server.ts#getVotesX"]', ['src/api.server.ts#getVotes'], false],
    ['["src/api.server.ts#getUser"]', ['src/api.server.ts#getVotes'], false],
    // a string pattern never prefix-matches a tuple canon
    ['["posts","u1"]', 'posts', false],
    // numbers / null elements
    ['["k",1,null]', ['k', 1], true],
    ['["k",12]', ['k', 1], false]
];

describe('keyMatches — server/cache parity (#452)', () => {
    it.each(CASES)('%s vs %j → %s (both sides agree)', (entryKey, pattern, expected) => {
        expect(serverMatch(entryKey, pattern)).toBe(expected);
        expect(cacheMatch(entryKey, pattern)).toBe(expected);
    });
});

describe('preparePattern — server/cache parity (#469)', () => {
    it.each(CASES)('%s vs %j → %s (prepared, both sides agree)', (entryKey, pattern, expected) => {
        expect(serverPrepare(pattern).match(entryKey)).toBe(expected);
        expect(cachePrepare(pattern).match(entryKey)).toBe(expected);
    });

    it('a prepared matcher stringifies a tuple once, then tests many keys', () => {
        // The optimization's contract: the canonical form is computed at
        // prepare time, so match() must not re-derive it. A prepared tuple
        // matcher agrees with the one-shot keyMatches on every key.
        const matcher = cachePrepare(['posts', 'u1']);
        for (const [entryKey, , ] of CASES) {
            expect(matcher.match(entryKey)).toBe(cacheMatch(entryKey, ['posts', 'u1']));
        }
    });
});
