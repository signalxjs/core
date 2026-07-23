/**
 * @vitest-environment node
 *
 * `keyMatches` parity (#452): the §6.3 admission gate duplicates
 * `@sigx/cache`'s matcher so `@sigx/server` stays cache-independent — one
 * `invalidates` declaration must mean the same thing on both sides. This
 * table runs identical fixtures through BOTH implementations; if they ever
 * diverge, this is the tripwire.
 */

import { describe, it, expect } from 'vitest';
import { keyMatches as serverMatch } from '../src/server/key-match';
import { keyMatches as cacheMatch } from '../../cache/src/store';

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
