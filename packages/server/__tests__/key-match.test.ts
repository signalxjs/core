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

import { afterEach, describe, it, expect, vi } from 'vitest';
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
    // fn-derived keys: ["<stableId>/<name>", ...args]
    ['["src/api.server.ts/getVotes"]', ['src/api.server.ts/getVotes'], true],
    ['["src/api.server.ts/getVotes",7]', ['src/api.server.ts/getVotes'], true],
    ['["src/api.server.ts/getVotesX"]', ['src/api.server.ts/getVotes'], false],
    ['["src/api.server.ts/getUser"]', ['src/api.server.ts/getVotes'], false],
    // a string pattern never prefix-matches a tuple canon
    ['["posts","u1"]', 'posts', false],
    // numbers / null elements
    ['["k",1,null]', ['k', 1], true],
    // object elements (#694): key-SORTED canonical form on both sides, so a
    // pattern spelled in another property order still meets the key
    ['["cart",{"a":2,"b":1},7]', ['cart', { b: 1, a: 2 }], true],
    ['["cart",{"a":2,"b":1},7]', ['cart', { a: 2, b: 1 }, 7], true],
    ['["cart",{"a":2,"b":1},7]', ['cart', { a: 2 }], false],
    ['["cart",{"a":2,"b":1}]', ['cart', { a: 2, b: 1, c: 3 }], false],
    // nested arrays and objects canonicalize recursively
    // (entry keys are always canonical — sorted — because useData mints them)
    ['["k",{"x":[1,{"y":null,"z":true}]}]', ['k', { x: [1, { z: true, y: null }] }], true],
    ['["k",{"x":[1,{"y":null,"z":true}]}]', ['k', { x: [1, { y: null, z: false }] }], false],
    ['["k",12]', ['k', 1], false]
];

describe('keyMatches — server/cache parity (#452)', () => {
    it.each(CASES)('%s vs %j → %s (both sides agree)', (entryKey, pattern, expected) => {
        expect(serverMatch(entryKey, pattern)).toBe(expected);
        expect(cacheMatch(entryKey, pattern)).toBe(expected);
    });
});

describe('preparePattern — server/cache parity (#469)', () => {
    // A spy on the global JSON.stringify must never leak past its test — a
    // thrown assertion would otherwise cascade into unrelated failures in
    // this worker.
    afterEach(() => vi.restoreAllMocks());

    it.each(CASES)('%s vs %j → %s (prepared, both sides agree)', (entryKey, pattern, expected) => {
        expect(serverPrepare(pattern).match(entryKey)).toBe(expected);
        expect(cachePrepare(pattern).match(entryKey)).toBe(expected);
    });

    it('a prepared tuple matcher stringifies once at prepare, never during match (#469)', () => {
        // The whole optimization: the canonical form is computed at prepare
        // time and match() must NOT re-derive it. Assert the contract
        // directly — a match() that re-stringified would pass a
        // result-parity test but reintroduce the exact cost this fixes.
        const spy = vi.spyOn(JSON, 'stringify');
        const cacheMatcher = cachePrepare(['posts', 'u1']);
        const cacheCalls = spy.mock.calls.length;
        const serverMatcher = serverPrepare(['posts', 'u1']);
        const serverCalls = spy.mock.calls.length - cacheCalls;
        // Each side canonicalizes at prepare time (per element since #694's
        // key-sorted canonical form) and does exactly the same amount of it.
        expect(cacheCalls).toBeGreaterThan(0);
        expect(serverCalls).toBe(cacheCalls);

        const afterPrepare = spy.mock.calls.length;
        for (const [entryKey] of CASES) {
            cacheMatcher.match(entryKey);
            serverMatcher.match(entryKey);
        }
        // Not one more JSON.stringify across every match on both sides.
        // (afterEach restores the spy even if this throws.)
        expect(spy.mock.calls.length).toBe(afterPrepare);
    });
});
