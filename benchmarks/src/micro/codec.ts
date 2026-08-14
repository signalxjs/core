/**
 * `@sigx/serialize` — the boundary codec, on the path of every RPC argument,
 * every result, every stream chunk, every SSR state blob and every boundary
 * record.
 *
 * What is measured is the FULL boundary operation, not the walk in isolation:
 * `JSON.stringify(encodeWithHandlers(x))` against a floor of plain
 * `JSON.stringify(x)`, and `reviveWithHandlers(JSON.parse(s))` against a floor
 * of plain `JSON.parse(s)`. The ratio to floor is the number that matters —
 * it is what a consumer pays for rich types over raw JSON, and it stays
 * meaningful across machines. The bare encode walk is benched too, so a fix
 * has a direct target.
 *
 * Since #657 each stringify case is measured BOTH ways against the same
 * floor: `encode+stringify X` (two walks — build the tree, re-walk it) and
 * `stringify X (one walk)`. Keeping the pair in one run on one machine is
 * what makes the delta readable at all; the ratios move together with the
 * hardware, and the gap between them is the intermediate tree.
 *
 * H1: `encode()` tests the whole handler chain on every node, primitives
 * included — `plainList` (1 000 rows, zero handler hits) is the pure-miss
 * case that isolates it.
 * H2: `chain()` re-allocates per top-level call when any handler is
 * registered — the `+handler` variants pay it, the plain ones do not.
 * H3: the second walk is roughly half the cost of the whole operation —
 * `encode plainList (walk only)` against `encode+stringify plainList` bounds
 * it, and the one-walk rows are what collect it.
 */
import {
    encodeWithHandlers,
    reviveWithHandlers,
    defineTypeHandler,
    type TypeHandler
} from '@sigx/serialize';
import { stringifyWithHandlers } from '@sigx/serialize/stringify';
import { assert, type MicroBench, type MicroSuite } from './types.ts';
import { plainList, richPayload, deepPayload, Money } from '../fixtures/payloads.ts';

const moneyHandler: TypeHandler<Money, number> = defineTypeHandler({
    name: 'money',
    tag: '$money',
    test: (v): v is Money => v instanceof Money,
    serialize: (m) => m.cents,
    revive: (cents) => new Money(cents)
});

const withHandler: readonly TypeHandler[] = [moneyHandler as TypeHandler];

/** Structural deep-equal good enough for a bench guard (post-revive shapes). */
function sameShape(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Map && b instanceof Map) {
        return a.size === b.size && [...a].every(([k, v]) => sameShape(v, b.get(k)));
    }
    if (a instanceof Set && b instanceof Set) {
        return a.size === b.size && [...a].every((v) => b.has(v));
    }
    if (a instanceof URL && b instanceof URL) return a.href === b.href;
    if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => sameShape(v, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length &&
            ka.every((k) => sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
    }
    return false;
}

/** Round-trip guard: the codec must actually preserve the fixture. */
function roundTrips(value: unknown, handlers: readonly TypeHandler[] = []): void {
    const back = reviveWithHandlers(
        JSON.parse(JSON.stringify(encodeWithHandlers(value, handlers))),
        handlers
    );
    assert(sameShape(value, back), 'codec round-trip changed the value');
}

/**
 * Guard for the one-walk benches (#657): the fused emitter's contract is BYTE
 * equality with the two-walk path, so a bench measuring it must assert exactly
 * that. Machine-independent and free — and without it, an emitter that quietly
 * dropped half the payload would report a spectacular number forever.
 */
function emitsSameBytes(value: unknown, handlers: readonly TypeHandler[] = []): void {
    roundTrips(value, handlers);
    assert(
        stringifyWithHandlers(value, handlers) === JSON.stringify(encodeWithHandlers(value, handlers)),
        'stringifyWithHandlers diverged from encode+stringify'
    );
}

const PLAIN_JSON = JSON.stringify(plainList);
const DEEP_JSON = JSON.stringify(deepPayload);
const RICH_JSON = JSON.stringify(encodeWithHandlers(richPayload));

export const codecSuite: MicroSuite = {
    name: 'codec',
    benches(): MicroBench[] {
        return [
            // --- the pure-miss path (H1) -----------------------------------
            {
                suite: 'codec',
                name: 'JSON.stringify plainList (floor)',
                isFloor: true,
                check: () => assert(PLAIN_JSON.length > 10_000, 'plainList JSON unexpectedly small'),
                run: () => JSON.stringify(plainList)
            },
            {
                suite: 'codec',
                name: 'encode+stringify plainList',
                floorOf: 'JSON.stringify plainList (floor)',
                quick: true,
                check: () => roundTrips(plainList),
                run: () => JSON.stringify(encodeWithHandlers(plainList))
            },
            {
                // The same boundary operation in ONE walk (#657). Its ratio
                // against the SAME floor, measured in the same run on the same
                // machine, is the whole point: the gap between this row and
                // the one above is the intermediate tree, which every caller
                // that wants a string was allocating and discarding.
                suite: 'codec',
                name: 'stringify plainList (one walk)',
                floorOf: 'JSON.stringify plainList (floor)',
                quick: true,
                check: () => emitsSameBytes(plainList),
                run: () => stringifyWithHandlers(plainList)
            },
            {
                suite: 'codec',
                name: 'encode plainList (walk only)',
                check: () => roundTrips(plainList),
                run: () => encodeWithHandlers(plainList)
            },
            {
                suite: 'codec',
                name: 'encode+stringify plainList +handler',
                floorOf: 'JSON.stringify plainList (floor)',
                check: () => roundTrips(plainList, withHandler),
                run: () => JSON.stringify(encodeWithHandlers(plainList, withHandler))
            },
            {
                // H2's pair: a registered handler adds a per-node `test()` to
                // both paths, so the one-walk win must survive it.
                suite: 'codec',
                name: 'stringify plainList +handler (one walk)',
                floorOf: 'JSON.stringify plainList (floor)',
                check: () => emitsSameBytes(plainList, withHandler),
                run: () => stringifyWithHandlers(plainList, withHandler)
            },
            {
                suite: 'codec',
                name: 'JSON.parse plainList (floor)',
                isFloor: true,
                check: () => assert(Array.isArray(JSON.parse(PLAIN_JSON)), 'plainList JSON is not an array'),
                run: () => JSON.parse(PLAIN_JSON)
            },
            {
                suite: 'codec',
                name: 'parse+revive plainList',
                floorOf: 'JSON.parse plainList (floor)',
                quick: true,
                check: () => roundTrips(plainList),
                run: () => reviveWithHandlers(JSON.parse(PLAIN_JSON))
            },

            // --- the hit path ----------------------------------------------
            // No floor: richPayload contains BigInt, so plain JSON.stringify
            // throws on it. Absolute numbers only.
            {
                suite: 'codec',
                name: 'encode+stringify richPayload',
                check: () => roundTrips(richPayload),
                run: () => JSON.stringify(encodeWithHandlers(richPayload))
            },
            {
                // The hit path in one walk — the shape a durable actor save
                // actually has (rows salted with Dates), which is where
                // signalxjs/actors#227 measured the second walk at +51%.
                suite: 'codec',
                name: 'stringify richPayload (one walk)',
                check: () => emitsSameBytes(richPayload),
                run: () => stringifyWithHandlers(richPayload)
            },
            {
                suite: 'codec',
                name: 'parse+revive richPayload',
                check: () => roundTrips(richPayload),
                run: () => reviveWithHandlers(JSON.parse(RICH_JSON))
            },

            // --- recursion depth --------------------------------------------
            {
                suite: 'codec',
                name: 'JSON.stringify deepPayload (floor)',
                isFloor: true,
                check: () => assert(DEEP_JSON.length > 100, 'deepPayload JSON unexpectedly small'),
                run: () => JSON.stringify(deepPayload)
            },
            {
                suite: 'codec',
                name: 'encode+stringify deepPayload',
                floorOf: 'JSON.stringify deepPayload (floor)',
                check: () => roundTrips(deepPayload),
                run: () => JSON.stringify(encodeWithHandlers(deepPayload))
            },
            {
                suite: 'codec',
                name: 'stringify deepPayload (one walk)',
                floorOf: 'JSON.stringify deepPayload (floor)',
                check: () => emitsSameBytes(deepPayload),
                run: () => stringifyWithHandlers(deepPayload)
            }
        ];
    }
};
