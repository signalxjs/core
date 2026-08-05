/**
 * Row matching and delta arithmetic for two quick payloads.
 *
 * Extracted from check-regression.ts (#638) so the interleaved A/B
 * (`ab-report.ts`) matches rows by exactly the same rules as the baseline
 * gate. There is no behaviour here that was not in check-regression before;
 * what changed is only that two callers now share it.
 *
 * Everything is matched by COMPOSITE NAME, never by index or order — a bench
 * added in the middle of a suite must not silently shift every row after it
 * onto the wrong baseline.
 */
import type { ResultsMeta } from './results.ts';
import type { QuickPayload } from './quick.ts';

export const DEFAULT_THRESHOLD_PCT = 25;

/**
 * Payload sizes are byte counts: identical on every machine, no sampling, no
 * noise. So they gate far tighter than timings — and, unlike timings, they
 * are NOT skipped when the baseline came from different hardware.
 */
export const BYTES_THRESHOLD_PCT = 2;

/**
 * Benches measured and printed but NOT gated (#474): their p50 is so small
 * (sub-0.1ms) that timer resolution and scheduling quantization dominate the
 * delta — the median is measuring the clock as much as the code, so run-to-run
 * jitter routinely exceeds the +25% threshold (`small-page` alone swung +38%
 * between two clean runs) and no sample budget steadies it. The renderer stays
 * gated by the larger string benches (`escape-heavy`), `large-table-1k`, and
 * the stream, so dropping these two from the GATE loses no real coverage —
 * only false alarms.
 *
 * This set is keyed on the string-bench label format and covers the SSR string
 * benches only; a request-path bench carries the same exemption per bench, via
 * `informational` in micro/types.ts.
 */
export const INFORMATIONAL_TIMINGS = new Set<string>([
    'small-page (string)',
    'escape-clean (string)'
]);

export interface DeltaRow {
    bench: string;
    baselineP50Ms: number;
    currentP50Ms: number;
    deltaPct: number;
    /** Byte-count rows are machine-independent — gated tighter, never skipped. */
    kind: 'time' | 'bytes';
    /** False for informational rows: printed and compared, but never fail. */
    gated: boolean;
}

export interface Comparison {
    /** Benches present on both sides — the only ones that can pass or fail. */
    rows: DeltaRow[];
    /** Measured now, absent from the baseline: compared against nothing. */
    ungated: string[];
    /** In the baseline, not measured now: the bench was renamed or removed. */
    stale: string[];
}

export function thresholdFor(row: DeltaRow, timingThreshold: number): number {
    return row.kind === 'bytes' ? BYTES_THRESHOLD_PCT : timingThreshold;
}

export function isRegression(row: DeltaRow, timingThreshold: number): boolean {
    return row.gated && row.deltaPct > thresholdFor(row, timingThreshold);
}

export function deltaPct(baseline: number, current: number): number {
    return ((current - baseline) / baseline) * 100;
}

/**
 * A quick payload, whether it came from a raw quick-latest.json (which IS the
 * payload) or from the combined baseline.json (which nests it under `quick`).
 */
export function isQuickPayload(value: unknown): value is QuickPayload {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as {
        string?: unknown;
        stream?: { results?: unknown };
        micro?: unknown;
        bytes?: unknown;
    };
    const arrayOrAbsent = (v: unknown): boolean => v === undefined || Array.isArray(v);
    // `micro` is the discriminator that actually bites: the quick payload holds
    // a flat array of benches, while the full suite's section is
    // `{meta, benches, bytes}`. Without checking it, a combined baseline whose
    // root looks quick-shaped gets this far and then dies on `.find` of an
    // object.
    return Array.isArray(candidate.string)
        && typeof candidate.stream === 'object'
        && candidate.stream !== null
        && Array.isArray(candidate.stream.results)
        && arrayOrAbsent(candidate.micro)
        && arrayOrAbsent(candidate.bytes);
}

export function streamLabels(scenario: string): [string, string] {
    return [`${scenario} (stream ttfb)`, `${scenario} (stream total)`];
}

export function compare(baseline: QuickPayload, current: QuickPayload): Comparison {
    const rows: DeltaRow[] = [];
    const ungated = new Set<string>();
    const stale = new Set<string>();

    for (const cur of current.string) {
        const bench = `${cur.scenario} (string)`;
        const base = baseline.string.find(
            (b) => b.scenario === cur.scenario && b.framework === cur.framework
        );
        if (!base) {
            ungated.add(bench);
            continue;
        }
        rows.push({
            bench,
            baselineP50Ms: Number((base.stats.p50Ns / 1e6).toFixed(3)),
            currentP50Ms: Number((cur.stats.p50Ns / 1e6).toFixed(3)),
            deltaPct: deltaPct(base.stats.p50Ns, cur.stats.p50Ns),
            kind: 'time',
            gated: !INFORMATIONAL_TIMINGS.has(bench)
        });
    }
    for (const base of baseline.string) {
        const measured = current.string.some(
            (c) => c.scenario === base.scenario && c.framework === base.framework
        );
        if (!measured) stale.add(`${base.scenario} (string)`);
    }

    // A renamed stream scenario un-matches every stream row at once, so it is
    // reported as the rename it is rather than quietly halving the coverage.
    const sameStreamScenario = baseline.stream.scenario === current.stream.scenario;
    for (const cur of current.stream.results) {
        const [ttfb, total] = streamLabels(current.stream.scenario);
        const base = sameStreamScenario
            ? baseline.stream.results.find((b) => b.framework === cur.framework)
            : undefined;
        if (!base) {
            ungated.add(ttfb);
            ungated.add(total);
            continue;
        }
        rows.push({
            bench: ttfb,
            baselineP50Ms: base.ttfbMs.p50,
            currentP50Ms: cur.ttfbMs.p50,
            deltaPct: deltaPct(base.ttfbMs.p50, cur.ttfbMs.p50),
            kind: 'time',
            gated: true
        });
        rows.push({
            bench: total,
            baselineP50Ms: base.totalMs.p50,
            currentP50Ms: cur.totalMs.p50,
            deltaPct: deltaPct(base.totalMs.p50, cur.totalMs.p50),
            kind: 'time',
            gated: true
        });
    }
    for (const base of baseline.stream.results) {
        const measured = sameStreamScenario
            && current.stream.results.some((c) => c.framework === base.framework);
        if (!measured) for (const label of streamLabels(baseline.stream.scenario)) stale.add(label);
    }

    // Request-path timings. A baseline recorded before these existed has no
    // `micro` section — every row is then reported as ungated, not skipped.
    for (const cur of current.micro ?? []) {
        const bench = `${cur.suite}/${cur.name}`;
        const base = (baseline.micro ?? []).find(
            (b) => b.suite === cur.suite && b.name === cur.name
        );
        if (!base) {
            ungated.add(bench);
            continue;
        }
        rows.push({
            bench,
            baselineP50Ms: Number((base.stats.p50Ns / 1e6).toFixed(4)),
            currentP50Ms: Number((cur.stats.p50Ns / 1e6).toFixed(4)),
            deltaPct: deltaPct(base.stats.p50Ns, cur.stats.p50Ns),
            kind: 'time',
            // Read off the CURRENT run: flipping a bench to informational takes
            // effect immediately, without waiting for a re-baseline.
            gated: !cur.informational
        });
    }
    for (const base of baseline.micro ?? []) {
        const measured = (current.micro ?? []).some(
            (c) => c.suite === base.suite && c.name === base.name
        );
        if (!measured) stale.add(`${base.suite}/${base.name}`);
    }

    // Payload sizes — the `ms` columns carry BYTES for these rows (the table
    // is shared); `kind` is what the threshold and the fingerprint skip read.
    for (const cur of current.bytes ?? []) {
        const bench = `${cur.suite}/${cur.name} (bytes)`;
        const base = (baseline.bytes ?? []).find(
            (b) => b.suite === cur.suite && b.name === cur.name
        );
        if (!base) {
            ungated.add(bench);
            continue;
        }
        rows.push({
            bench,
            baselineP50Ms: base.bytes,
            currentP50Ms: cur.bytes,
            deltaPct: deltaPct(base.bytes, cur.bytes),
            kind: 'bytes',
            gated: true
        });
    }
    for (const base of baseline.bytes ?? []) {
        const measured = (current.bytes ?? []).some(
            (c) => c.suite === base.suite && c.name === base.name
        );
        if (!measured) stale.add(`${base.suite}/${base.name} (bytes)`);
    }

    return { rows, ungated: [...ungated].sort(), stale: [...stale].sort() };
}

export function formatDelta(row: DeltaRow): string {
    return `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`;
}

export function metaLine(label: string, meta: ResultsMeta | undefined): string {
    if (!meta) return `${label}: unknown`;
    return `${label}: \`${meta.cpu}\`, node ${meta.node}, ${meta.date}`;
}
