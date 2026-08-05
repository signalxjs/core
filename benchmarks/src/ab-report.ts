/**
 * Turn the interleaved rounds `ab.ts` recorded into a verdict per bench.
 *
 * The old A/B reported one number per row: `deltaPct(base.p50, head.p50)` from
 * a single measurement of each side. That number cannot distinguish a real 5%
 * change from the machine being 5% busier during the second half of the job,
 * and #637 showed the latter reaching +6.6% on a PR that changed no package
 * source at all.
 *
 * With R paired rounds there is something honest to say instead. For each row
 * we have R base p50s and R head p50s, measured alternately, so:
 *
 *   d_i = head_i / base_i - 1            the per-round paired delta
 *   spread(side) = max/min - 1           how much that side moved run to run
 *
 * and a verdict follows from the two together:
 *
 * - `noisy`     — a side's own spread exceeds NOISY_SPREAD_PCT. The row could
 *                 not hold still while measuring itself, so it cannot resolve
 *                 anything about the change. Reported, never claimed.
 * - `regressed` — every round agrees in sign AND the median delta clears both
 *   `improved`    the minimum effect size and the observed spread. Unanimity
 *                 across R independent rounds is a sign test at p = 2^-R
 *                 (~3% at R=5); requiring the effect to exceed the spread stops
 *                 a row from being called on a margin its own noise covers.
 * - `no change` — otherwise.
 *
 * Byte rows skip all of it: a byte count has no variance, so any movement at
 * all is real and a row that somehow differs BETWEEN rounds indicates
 * nondeterministic output rather than a size change.
 *
 * The table reports the raw `[min d_i, max d_i]` rather than a bootstrap
 * interval. At R=5 a bootstrap would be resampling five points and dressing the
 * same information as a confidence interval; the range says what actually
 * happened and needs no assumptions.
 *
 * Usage:
 *   node --conditions production benchmarks/src/ab-report.ts \
 *     --rounds-file=<path> [--markdown=<path>] [--title=<text>] [--enforce]
 */
import fs from 'node:fs';
import type { ResultsMeta } from './results.ts';
import type { QuickPayload } from './quick.ts';
import { BYTES_THRESHOLD_PCT, compare, isQuickPayload, metaLine, type DeltaRow } from './compare.ts';

/**
 * A side that moves more than this run-to-run cannot resolve an effect smaller
 * than its own wobble, whatever the median says.
 */
const NOISY_SPREAD_PCT = 10;

/**
 * Floor on the claimed effect. Unanimity alone is not enough: five rounds can
 * agree in sign on a 0.4% difference and mean nothing useful.
 */
const MIN_EFFECT_PCT = 3;

type Verdict = 'improved' | 'regressed' | 'no change' | 'noisy' | 'info' | 'unchanged' | 'changed';

interface RoundRecord {
    index: number;
    order: string[];
    base: unknown;
    head: unknown;
}

interface SeriesRow {
    bench: string;
    kind: DeltaRow['kind'];
    gated: boolean;
    base: number[];
    head: number[];
}

interface VerdictRow extends SeriesRow {
    baseMedian: number;
    headMedian: number;
    deltas: number[];
    medianDelta: number;
    minDelta: number;
    maxDelta: number;
    baseSpread: number;
    headSpread: number;
    verdict: Verdict;
}

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
    console.error(`[ab-report] ${message}`);
    process.exit(1);
}

/** Lower-middle median, matching quick.ts's `medianNs`. */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** max/min - 1, as a percentage. Zero-safe: a zero-valued side has no spread. */
function spreadPct(values: number[]): number {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min <= 0) return max === min ? 0 : Infinity;
    return (max / min - 1) * 100;
}

function allSameSign(deltas: number[]): boolean {
    return deltas.every((d) => d > 0) || deltas.every((d) => d < 0);
}

function verdictFor(row: SeriesRow, deltas: number[], baseSpread: number, headSpread: number): Verdict {
    if (row.kind === 'bytes') {
        // Deterministic: identical input must produce an identical byte count,
        // so any movement is a real size change and needs no statistics.
        return deltas.every((d) => d === 0) ? 'unchanged' : 'changed';
    }
    if (!row.gated) return 'info';
    if (Math.max(baseSpread, headSpread) > NOISY_SPREAD_PCT) return 'noisy';

    const med = median(deltas);
    const floor = Math.max(MIN_EFFECT_PCT, baseSpread, headSpread);
    if (!allSameSign(deltas) || Math.abs(med) < floor) return 'no change';
    return med > 0 ? 'regressed' : 'improved';
}

function quickOf(value: unknown, round: number, side: string): QuickPayload {
    if (!isQuickPayload(value)) fail(`round ${round + 1} ${side}: not a quick payload`);
    return value;
}

/**
 * Collect each bench's per-round p50 pair. A bench is only given a verdict when
 * it matched on both sides in EVERY round — a row measured in some rounds and
 * not others would otherwise have "all rounds agree" mean something different
 * per row, silently.
 */
function buildSeries(rounds: RoundRecord[]): { series: SeriesRow[]; partial: string[] } {
    const byBench = new Map<string, SeriesRow>();

    rounds.forEach((round, i) => {
        const comparison = compare(
            quickOf(round.base, i, 'base'),
            quickOf(round.head, i, 'head')
        );
        for (const row of comparison.rows) {
            let entry = byBench.get(row.bench);
            if (!entry) {
                entry = { bench: row.bench, kind: row.kind, gated: row.gated, base: [], head: [] };
                byBench.set(row.bench, entry);
            }
            // A bench flipped to `informational` mid-flight would be read off
            // the last round otherwise; gate it if ANY round said to.
            entry.gated = entry.gated && row.gated;
            entry.base.push(row.baselineP50Ms);
            entry.head.push(row.currentP50Ms);
        }
    });

    const series: SeriesRow[] = [];
    const partial: string[] = [];
    for (const entry of byBench.values()) {
        if (entry.base.length === rounds.length && entry.head.length === rounds.length) {
            series.push(entry);
        } else {
            partial.push(`${entry.bench} (matched in ${entry.base.length}/${rounds.length} rounds)`);
        }
    }
    series.sort((a, b) => a.bench.localeCompare(b.bench));
    return { series, partial: partial.sort() };
}

function toVerdictRows(series: SeriesRow[]): VerdictRow[] {
    return series.map((row) => {
        const deltas = row.base.map((b, i) => (b === 0 ? 0 : (row.head[i] / b - 1) * 100));
        const baseSpread = spreadPct(row.base);
        const headSpread = spreadPct(row.head);
        return {
            ...row,
            baseMedian: median(row.base),
            headMedian: median(row.head),
            deltas,
            medianDelta: median(deltas),
            minDelta: Math.min(...deltas),
            maxDelta: Math.max(...deltas),
            baseSpread,
            headSpread,
            verdict: verdictFor(row, deltas, baseSpread, headSpread)
        };
    });
}

function pct(value: number): string {
    if (!Number.isFinite(value)) return 'n/a';
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function markdownReport(
    rows: VerdictRow[],
    partial: string[],
    roundCount: number,
    baseMeta: ResultsMeta | undefined,
    headMeta: ResultsMeta | undefined,
    title: string | undefined
): string {
    const lines: string[] = [];
    lines.push('### Benchmark comparison');
    if (title) lines.push('', title);
    lines.push('');

    if (rows.length === 0) {
        lines.push('_No bench matched on both sides in every round — nothing to compare._');
    } else {
        lines.push('| bench | before | after | delta (median) | round range | verdict |');
        lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
        for (const row of rows) {
            const range = row.kind === 'bytes'
                ? '—'
                : `${pct(row.minDelta)} … ${pct(row.maxDelta)}`;
            const mark = row.verdict === 'regressed' || row.verdict === 'changed' ? '**' : '';
            lines.push(
                `| ${row.bench} | ${row.baseMedian} | ${row.headMedian} | ${pct(row.medianDelta)} | ${range} | ${mark}${row.verdict}${mark} |`
            );
        }
    }

    if (partial.length > 0) {
        lines.push('', `**Not every round** — matched on both sides in some rounds only, so no verdict (${partial.length}):`);
        for (const bench of partial) lines.push(`- \`${bench}\``);
    }

    lines.push('');
    lines.push(`<sub>${metaLine('before', baseMeta)}</sub><br>`);
    lines.push(`<sub>${metaLine('after', headMeta)}</sub><br>`);
    lines.push(
        `<sub>${roundCount} rounds, base and head alternated and counterbalanced. `
        + `A verdict of \`improved\`/\`regressed\` needs every round to agree in sign (a sign test at p = 2^-${roundCount}) `
        + `AND a median delta above both ${MIN_EFFECT_PCT}% and the row's own run-to-run spread; \`noisy\` means that spread `
        + `exceeded ${NOISY_SPREAD_PCT}% and the row cannot resolve the change. Figures are millisecond p50s except `
        + `\`(bytes)\` rows, which are exact byte counts and gate at +${BYTES_THRESHOLD_PCT}%.</sub>`
    );
    return lines.join('\n') + '\n';
}

function printTable(rows: VerdictRow[]): void {
    console.table(rows.map((r) => ({
        bench: r.bench,
        before: r.baseMedian,
        after: r.headMedian,
        'delta (median)': pct(r.medianDelta),
        'round range': r.kind === 'bytes' ? '—' : `${pct(r.minDelta)} … ${pct(r.maxDelta)}`,
        spread: r.kind === 'bytes' ? '—' : `${pct(r.baseSpread)} / ${pct(r.headSpread)}`,
        verdict: r.verdict
    })));
}

function main(): void {
    const roundsFile = argValue('rounds-file');
    if (!roundsFile) fail('missing --rounds-file=<path>');
    if (!fs.existsSync(roundsFile)) fail(`rounds file not found: ${roundsFile}`);

    const parsed = JSON.parse(fs.readFileSync(roundsFile, 'utf8')) as { rounds?: RoundRecord[] };
    const rounds = parsed.rounds ?? [];
    if (rounds.length < 2) fail(`need at least 2 rounds to compare, got ${rounds.length}`);

    const { series, partial } = buildSeries(rounds);
    const rows = toVerdictRows(series);

    printTable(rows);
    if (partial.length > 0) {
        console.log(`\nno verdict — matched in some rounds only (${partial.length}):`);
        for (const bench of partial) console.log(`  - ${bench}`);
    }

    const baseMeta = (rounds[0].base as QuickPayload | undefined)?.meta;
    const headMeta = (rounds[0].head as QuickPayload | undefined)?.meta;
    const markdownPath = argValue('markdown');
    if (markdownPath) {
        const report = markdownReport(rows, partial, rounds.length, baseMeta, headMeta, argValue('title'));
        fs.writeFileSync(markdownPath, report);
        console.log(`\nwrote ${markdownPath}`);
    }

    const regressions = rows.filter((r) => r.verdict === 'regressed' || r.verdict === 'changed');
    if (regressions.length > 0) {
        console.log(`\n${regressions.length} row(s) regressed:`);
        for (const row of regressions) {
            console.log(`  - ${row.bench}: ${pct(row.medianDelta)} (rounds ${pct(row.minDelta)} … ${pct(row.maxDelta)})`);
        }
    }

    // Advisory unless asked otherwise: bench.yml's PR path must never block a
    // merge, so --enforce exists for the deliberate proof run only.
    if (process.argv.includes('--enforce') && regressions.length > 0) {
        console.error('\n[ab-report] FAIL: the above regressed with every round agreeing.');
        process.exit(1);
    }
}

main();
