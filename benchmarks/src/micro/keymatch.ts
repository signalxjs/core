/**
 * Canonical-key pattern matching — the §6.3 boundary-refresh admission gate,
 * measured end to end through `handleServerFnRequest`.
 *
 * The gate filters `descriptors × deps × patterns` through `keyMatches`, so
 * this is where the matcher's per-call cost is observable through a public
 * API. `@sigx/cache`'s `invalidate()` runs the DUPLICATED twin of that
 * matcher (`packages/cache/src/store.ts` — a parity test pins the two
 * identical) over its entry map; `CacheStore` has no public constructor, so
 * the twin is not benched separately. The per-call cost measured here is the
 * cost `invalidate()` pays per entry.
 *
 * The experiment that makes H4/H5 falsifiable: two pattern sets doing the
 * SAME number of `keyMatches` calls, one of plain strings (the matcher's
 * early return on `===`, no `JSON.stringify` anywhere) and one of tuples (a
 * `JSON.stringify` of the pattern INSIDE the per-entry loop). The delta
 * between them is the hoistable work — if it is flat, the hypothesis is dead.
 * Every pattern in a variant is of that variant's kind, the matching one
 * included, so the control never strays onto the tuple branch.
 *
 * `renderBoundaries` returns `[]`, so nothing is rendered: only the gate and
 * the envelope are on the clock.
 */
import { serverFn } from '@sigx/server';
import { handleServerFnRequest } from '@sigx/server/server';
import { assert, type MicroBench, type MicroSuite } from './types.ts';

const ORIGIN = 'http://localhost';
const BASE = `${ORIGIN}/_sigx/fn`;

/**
 * Deps sized so the WHOLE scan runs: both `deps.some()` and `patterns.some()`
 * short-circuit on their first hit, so every dep but the last misses every
 * pattern, and the one matching pattern sits last in the list. Without that
 * the gate would exit after one comparison and the sweep would measure
 * nothing.
 */
function deps(count: number): string[] {
    const list = Array.from({ length: count - 1 }, (_, i) =>
        JSON.stringify(['widgets', `w${i}`, i])
    );
    list.push(JSON.stringify(['hit', 'last']));
    return list;
}

function descriptors(count: number, depsPer: number): unknown[] {
    const shared = deps(depsPer);
    return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        component: 'Tracker',
        deps: shared,
        props: { n: i }
    }));
}

// 63 decoys + 1 match = the endpoint's MAX_INVALIDATE_PATTERNS (64) exactly.
// One more and the endpoint's `slice(0, 64)` would drop the matching pattern
// and nothing would ever be admitted.
const DECOYS = 63;
/** Tuple patterns — `keyMatches` stringifies each one per dep it is tried against. */
const TUPLE_PATTERNS = Array.from({ length: DECOYS }, (_, i) => ['posts', `u${i}`] as const);
/** String patterns — same call count, but the matcher returns on `===`. */
const STRING_PATTERNS = Array.from({ length: DECOYS }, (_, i) => `posts-u${i}`);

// One `invalidates` pattern must MATCH, or nothing is admitted — and it goes
// LAST so the 63 misses are all tried first (see `deps` above). It matches
// only the final dep. Each variant uses its OWN kind of matching pattern, so
// the string control never touches the tuple branch: a tuple match by prefix,
// a string match by equality against the final dep's canonical form.
const MATCHING_TUPLE = ['hit'] as const;
const MATCHING_STRING = JSON.stringify(['hit', 'last']);

const tupleMutation = serverFn({
    handler: async () => ({ ok: true }),
    invalidates: () => [...TUPLE_PATTERNS, MATCHING_TUPLE]
});
const stringMutation = serverFn({
    handler: async () => ({ ok: true }),
    invalidates: () => [...STRING_PATTERNS, MATCHING_STRING]
});

const REGISTRY: Record<string, unknown> = {
    tupleMutation_fn_00000001: tupleMutation,
    stringMutation_fn_00000002: stringMutation
};

let admitted = 0;
const options = {
    resolve: (symbol: string) => REGISTRY[symbol] ?? null,
    // The gate's output, not a render — the descriptors it admitted.
    renderBoundaries: (requests: ReadonlyArray<unknown>): unknown[] => {
        admitted = requests.length;
        return [];
    }
};

function request(symbol: string, descriptorCount: number, depsPer: number): Request {
    return new Request(`${BASE}/${symbol}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
            args: [{}],
            $boundaries: { base: 1000, refresh: descriptors(descriptorCount, depsPer) }
        })
    });
}

/** The gate must actually have run and admitted every descriptor. */
function guard(symbol: string, descriptorCount: number, depsPer: number) {
    return async (): Promise<void> => {
        admitted = 0;
        const res = await handleServerFnRequest(request(symbol, descriptorCount, depsPer), options);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const envelope = (await res.json()) as { $cache?: { invalidates?: unknown[] } };
        assert(
            (envelope.$cache?.invalidates?.length ?? 0) > 0,
            'no $cache directives — `invalidates` never resolved, so the gate never ran'
        );
        assert(
            admitted === descriptorCount,
            `gate admitted ${admitted} of ${descriptorCount} descriptors — it is not doing the work being measured`
        );
    };
}

function gateBench(
    label: string,
    symbol: string,
    descriptorCount: number,
    depsPer: number,
    quick = false
): MicroBench {
    return {
        suite: 'keymatch',
        name: label,
        quick,
        check: guard(symbol, descriptorCount, depsPer),
        run: () => handleServerFnRequest(request(symbol, descriptorCount, depsPer), options)
    };
}

export const keyMatchSuite: MicroSuite = {
    name: 'keymatch',
    benches(): MicroBench[] {
        return [
            // Sweep the call count: 1/8/32 descriptors × 8/32 deps × 64 patterns.
            gateBench('gate 1x8 deps, 64 tuple patterns', 'tupleMutation_fn_00000001', 1, 8),
            gateBench('gate 8x32 deps, 64 tuple patterns', 'tupleMutation_fn_00000001', 8, 32, true),
            gateBench('gate 32x32 deps, 64 tuple patterns', 'tupleMutation_fn_00000001', 32, 32),
            // Same call counts, string patterns — the stringify-free control.
            gateBench('gate 8x32 deps, 64 string patterns', 'stringMutation_fn_00000002', 8, 32),
            gateBench('gate 32x32 deps, 64 string patterns', 'stringMutation_fn_00000002', 32, 32)
        ];
    }
};
