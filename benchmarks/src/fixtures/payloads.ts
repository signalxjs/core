/**
 * Deterministic payloads for the request-path benches — the values that
 * cross a boundary, as opposed to the component trees in ../scenarios/.
 *
 * All of it derives from the seeded rows in ../scenarios/data.ts: one
 * generator for the whole workspace, so a payload never drifts between the
 * SSR suite and the micro suite.
 */
import { ROWS_1K, mulberry32, type TableRow } from '../scenarios/data.ts';

/** The realistic read result: 1 000 flat, JSON-safe row objects. */
export const plainList: TableRow[] = ROWS_1K;

/** A smaller slice, for benches where 1 000 rows would drown fixed overhead. */
export const plainListSmall: TableRow[] = ROWS_1K.slice(0, 50);

export interface RichRow extends TableRow {
    createdAt: Date;
    tags: Set<string>;
    meta: Map<string, string | number>;
    balance: bigint;
    profile: URL;
}

/**
 * The same rows salted with every built-in codec type — the handler chain's
 * HIT path (plainList only ever exercises the miss path, which is where the
 * per-node `test()` sweep costs the most).
 */
export const richPayload: RichRow[] = plainListSmall.map((row, i) => ({
    ...row,
    createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28), i % 24)),
    tags: new Set([row.role, `g${i % 13}`, 'bench']),
    meta: new Map<string, string | number>([
        ['rank', i],
        ['bucket', `b${i % 7}`],
        ['weight', row.score]
    ]),
    balance: BigInt(row.id) * 1_000_000_007n,
    profile: new URL(`https://example.com/u/${row.id}`)
}));

export interface DeepNode {
    label: string;
    weight: number;
    child: DeepNode | null;
    siblings: string[];
}

/** Nesting depth ~12 — recursion cost with no type-handler hits. */
export const deepPayload: DeepNode = (() => {
    const rng = mulberry32(0xbeef1);
    const make = (depth: number): DeepNode => ({
        label: `node-${depth}`,
        weight: Math.round(rng() * 10000) / 100,
        siblings: Array.from({ length: 4 }, (_, i) => `s${depth}-${i}`),
        child: depth <= 1 ? null : make(depth - 1)
    });
    return make(12);
})();

/** The mutation-argument shape: tiny, so fixed per-call overhead dominates. */
export const smallArgs: [{ id: number; qty: number }] = [{ id: 42, qty: 3 }];

/**
 * A custom type, for the "one registered handler" codec variants (H2).
 * Plain field assignment, not a parameter property — these files run through
 * node's strip-only type stripping, which rejects the shorthand.
 */
export class Money {
    cents: number;
    constructor(cents: number) {
        this.cents = cents;
    }
}

/** Canonical `useData` keys, the shape the cache store and the §6.3 gate see. */
export function cacheKeys(n: number): string[] {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
        // A realistic mix: bare string keys and canonical tuple keys.
        keys.push(i % 3 === 0 ? `plain-key-${i}` : JSON.stringify(['posts', `u${i % 97}`, i]));
    }
    return keys;
}
