/**
 * The shared shape of a request-path micro bench.
 *
 * One definition list per suite, consumed by BOTH `run-micro.ts` (full mitata
 * run, grouped per suite) and `quick.ts` (the reduced, regression-gated
 * subset) — so the gated numbers can never drift from the full-run numbers by
 * measuring something subtly different.
 */

export type SuiteName = 'codec' | 'serverfn' | 'keymatch' | 'refresh' | 'packs' | 'slots';

export interface MicroBench {
    suite: SuiteName;
    /** Unique within the suite — the identity `check-regression` matches on. */
    name: string;
    /**
     * Name of the bench in the SAME suite that is this one's floor (the
     * irreducible work: raw JSON, a bare fetch handler). Reported as a ratio,
     * which is the figure that survives a machine change.
     */
    floorOf?: string;
    /** Marks a bench as itself being a floor — excluded from the quick subset. */
    isFloor?: boolean;
    /** Included in the reduced quick suite (one or two per suite). */
    quick?: boolean;
    /**
     * Measured and printed by the quick suite, but never gated by
     * `check-regression` (#474/#477). For a p50 down in the tens of
     * nanoseconds, timer resolution and scheduling quantization dominate the
     * delta — the median measures the clock as much as the code, so run-to-run
     * jitter routinely exceeds the threshold and no sample budget steadies it.
     * Such a bench earns its keep through its `check()` guard and its
     * `floorOf` ratio, not through an absolute-p50 gate.
     */
    informational?: boolean;
    /**
     * Correctness guard, run ONCE before measuring. Must throw on anything
     * unexpected: a bench that silently measures a 403, an empty render, or a
     * plugin that failed to install would otherwise report a flattering
     * number forever.
     */
    check(): void | Promise<void>;
    run(): unknown | Promise<unknown>;
}

/**
 * A deterministic byte count (payload size). Machine-independent, so these
 * gate far tighter than timings and are never skipped on a fingerprint
 * mismatch.
 */
export interface ByteMetric {
    suite: SuiteName;
    name: string;
    bytes: number;
}

export interface MicroSuite {
    name: SuiteName;
    /** Built lazily so a suite's setup cost is not paid by unrelated runs. */
    benches(): MicroBench[] | Promise<MicroBench[]>;
    /** Optional payload-size metrics (packs). */
    bytes?(): ByteMetric[] | Promise<ByteMetric[]>;
}

/** Assertion helper — bench guards are not a test runner, but they must fail loudly. */
export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`[bench check] ${message}`);
}
