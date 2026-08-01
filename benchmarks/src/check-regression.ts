/**
 * Compare results/quick-latest.json (sigx quick suite, see quick.ts) against
 * the `quick` section of the committed results/baseline.json and print a
 * delta table.
 *
 * Default: informational only (always exit 0). With --enforce: any median
 * regression beyond the threshold (default +25%, override with
 * --threshold=<pct>) triggers ONE re-run of the whole quick suite as a noise
 * filter; if the regression persists, exit 1.
 *
 * Two kinds of row, gated differently:
 *
 * - **timings** (SSR renders, streams, the request-path subset) — sampled, so
 *   they carry the +25% threshold, the noise re-run, and the fingerprint skip.
 * - **payload bytes** (the SSR packs' rendered output) — a byte count is
 *   identical on every machine and has no variance, so it gates at +2%, fails
 *   without a re-run (a re-run cannot absolve it), and is enforced even when
 *   the baseline came from different hardware.
 *
 * Machine fingerprint: if the baseline was recorded on a different CPU model
 * or Node major version the TIMINGS are not comparable — a warning is printed
 * and only the byte rows keep gating.
 *
 * Coverage: a bench with no matching entry on the baseline side cannot fail —
 * it is measured, printed, and compared against nothing. That used to be
 * silent (`if (!base) continue`), which left the three `slots/*` benches added
 * by #537 ungated for four PRs. Unmatched rows are now listed on every run in
 * both directions (`ungated` / `stale`), and --require-baseline-rows (implied
 * by --enforce) turns an ungated row into a failure. That check is set
 * membership, not timing, so it needs no matching hardware and CI runs it.
 *
 * Files: --baseline-file / --current-file compare two arbitrary result files
 * instead of the committed baseline — how the Bench workflow's A/B job
 * compares a PR's base ref against its head ref, both measured on the same
 * runner. --markdown=<path> writes that comparison as a report to post.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESULTS_DIR, type ResultsMeta } from './results.ts';
import type { QuickPayload } from './quick.ts';

const QUICK_LATEST = path.join(RESULTS_DIR, 'quick-latest.json');
const BASELINE = path.join(RESULTS_DIR, 'baseline.json');

const DEFAULT_THRESHOLD_PCT = 25;
/**
 * Payload sizes are byte counts: identical on every machine, no sampling, no
 * noise. So they gate far tighter than timings — and, unlike timings, they
 * are NOT skipped when the baseline came from different hardware.
 */
const BYTES_THRESHOLD_PCT = 2;

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
const INFORMATIONAL_TIMINGS = new Set<string>([
    'small-page (string)',
    'escape-clean (string)'
]);

interface DeltaRow {
    bench: string;
    baselineP50Ms: number;
    currentP50Ms: number;
    deltaPct: number;
    /** Byte-count rows are machine-independent — gated tighter, never skipped. */
    kind: 'time' | 'bytes';
    /** False for informational rows: printed and compared, but never fail. */
    gated: boolean;
}

interface Comparison {
    /** Benches present on both sides — the only ones that can pass or fail. */
    rows: DeltaRow[];
    /** Measured now, absent from the baseline: compared against nothing. */
    ungated: string[];
    /** In the baseline, not measured now: the bench was renamed or removed. */
    stale: string[];
}

function thresholdFor(row: DeltaRow, timingThreshold: number): number {
    return row.kind === 'bytes' ? BYTES_THRESHOLD_PCT : timingThreshold;
}

function isRegression(row: DeltaRow, timingThreshold: number): boolean {
    return row.gated && row.deltaPct > thresholdFor(row, timingThreshold);
}

function readJson<T>(file: string, what: string): T {
    if (!fs.existsSync(file)) {
        console.error(`[check-regression] ${what} not found: ${file}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** `--name=value`, or undefined when the flag was not passed. */
function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function thresholdPct(): number {
    const raw = argValue('threshold');
    if (raw === undefined) return DEFAULT_THRESHOLD_PCT;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        console.error(`[check-regression] invalid --threshold value: --threshold=${raw}`);
        process.exit(1);
    }
    return value;
}

function nodeMajor(version: string): string {
    return version.replace(/^v/, '').split('.')[0];
}

function deltaPct(baseline: number, current: number): number {
    return ((current - baseline) / baseline) * 100;
}

/**
 * A quick payload, whether it came from a raw quick-latest.json (which IS the
 * payload) or from the combined baseline.json (which nests it under `quick`).
 */
function isQuickPayload(value: unknown): value is QuickPayload {
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

function streamLabels(scenario: string): [string, string] {
    return [`${scenario} (stream ttfb)`, `${scenario} (stream total)`];
}

function compare(baseline: QuickPayload, current: QuickPayload): Comparison {
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

function printTable(rows: DeltaRow[]): void {
    console.table(rows.map((r) => ({
        bench: r.gated ? r.bench : `${r.bench} (info)`,
        'baseline (ms|bytes)': r.baselineP50Ms,
        'current (ms|bytes)': r.currentP50Ms,
        'delta %': `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`
    })));
}

function printCoverage({ ungated, stale }: Comparison): void {
    if (ungated.length > 0) {
        console.log(`\nungated — measured but no baseline entry, cannot fail (${ungated.length}):`);
        for (const bench of ungated) console.log(`  - ${bench}`);
    }
    if (stale.length > 0) {
        console.log(`\nstale — in the baseline but not measured, so the bench was renamed or removed (${stale.length}):`);
        for (const bench of stale) console.log(`  - ${bench}`);
    }
    if (ungated.length > 0 && stale.length > 0) {
        console.log('\n(a bench in both lists was renamed — the two entries are its old and new name.)');
    }
}

function formatDelta(row: DeltaRow): string {
    return `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`;
}

function metaLine(label: string, meta: ResultsMeta | undefined): string {
    if (!meta) return `${label}: unknown`;
    return `${label}: \`${meta.cpu}\`, node ${meta.node}, ${meta.date}`;
}

/**
 * The same comparison as the console table, as a report to post on a PR. Kept
 * deliberately generic — "before"/"after" rather than "baseline"/"current" —
 * because the A/B job's two sides are a base ref and a head ref, neither of
 * which is the committed baseline. `--title` says which is which.
 */
function markdownReport(
    comparison: Comparison,
    threshold: number,
    baselineMeta: ResultsMeta | undefined,
    currentMeta: ResultsMeta | undefined,
    title: string | undefined
): string {
    const { rows, ungated, stale } = comparison;
    const lines: string[] = [];
    lines.push('### Benchmark comparison');
    if (title) lines.push('', title);
    lines.push('');

    if (rows.length === 0) {
        lines.push('_No bench matched on both sides — nothing to compare._');
    } else {
        lines.push('| bench | before | after | delta | |');
        lines.push('| --- | ---: | ---: | ---: | --- |');
        for (const row of rows) {
            const status = !row.gated
                ? 'info'
                : isRegression(row, threshold)
                    ? `over +${thresholdFor(row, threshold)}%`
                    : 'ok';
            lines.push(
                `| ${row.bench} | ${row.baselineP50Ms} | ${row.currentP50Ms} | ${formatDelta(row)} | ${status} |`
            );
        }
    }

    if (ungated.length > 0) {
        lines.push('', `**Ungated** — measured but absent from the "before" side, so nothing compares them (${ungated.length}):`);
        for (const bench of ungated) lines.push(`- \`${bench}\``);
    }
    if (stale.length > 0) {
        lines.push('', `**Stale** — on the "before" side but not measured now, so renamed or removed (${stale.length}):`);
        for (const bench of stale) lines.push(`- \`${bench}\``);
    }

    lines.push('');
    lines.push(`<sub>${metaLine('before', baselineMeta)}</sub><br>`);
    lines.push(`<sub>${metaLine('after', currentMeta)}</sub><br>`);
    lines.push(
        `<sub>Thresholds for reference: +${threshold}% timings, +${BYTES_THRESHOLD_PCT}% payload bytes. `
        + 'Timings measured on a shared CI runner are indicative, never a gate — the `(bytes)` rows are exact. '
        + 'Figures are millisecond p50s except those `(bytes)` rows, which are byte counts.</sub>'
    );
    return lines.join('\n') + '\n';
}

function main(): void {
    const enforce = process.argv.includes('--enforce');
    const requireBaselineRows = enforce || process.argv.includes('--require-baseline-rows');
    const threshold = thresholdPct();
    const baselinePath = argValue('baseline-file');
    const currentPath = argValue('current-file');
    const markdownPath = argValue('markdown');
    const title = argValue('title');

    // The noise re-run respawns quick.ts, which always writes quick-latest.json
    // — it cannot re-measure a file handed in from elsewhere. Rather than
    // enforce a verdict against a file it is unable to re-measure, refuse.
    if (enforce && currentPath !== undefined) {
        console.error('[check-regression] --enforce cannot be combined with --current-file: the noise re-run re-measures results/quick-latest.json, not an arbitrary file.');
        process.exit(1);
    }

    const baselineFile = readJson<Record<string, unknown> & { meta?: ResultsMeta; quick?: QuickPayload }>(
        baselinePath ?? BASELINE,
        'baseline'
    );
    const current = readJson<QuickPayload>(currentPath ?? QUICK_LATEST, 'quick results');

    // The root of a combined baseline.json carries `string`/`stream`/`micro`
    // too — the very shape a raw quick payload has — so a structural test
    // cannot tell them apart, and falling through to the root would compare
    // the quick suite against FULL-suite numbers recorded under a different
    // sample budget. Only the `quick` key distinguishes them, so it wins
    // whenever it is present, and the root is considered only for an explicit
    // --baseline-file (which the A/B job points at a raw quick-latest.json).
    // The default path therefore keeps its "no quick section" early exit.
    let baselineQuick: QuickPayload | undefined;
    if ('quick' in baselineFile) {
        baselineQuick = isQuickPayload(baselineFile.quick) ? baselineFile.quick : undefined;
    } else if (baselinePath !== undefined) {
        baselineQuick = isQuickPayload(baselineFile) ? baselineFile : undefined;
    }
    if (!baselineQuick) {
        if (baselinePath !== undefined) {
            // An explicit path holding neither shape is a mistake, not a
            // missing baseline — say so instead of silently passing.
            console.error(`[check-regression] ${baselinePath} is neither a quick results file nor a baseline with a \`quick\` section.`);
            process.exit(1);
        }
        console.warn('[check-regression] baseline.json has no `quick` section — run `node src/quick.ts --baseline` (or `pnpm bench:ssr:baseline`) on this machine first. Skipping comparison.');
        process.exit(0);
    }

    let comparison = compare(baselineQuick, current);
    let rows = comparison.rows;
    if (rows.length > 0) printTable(rows);
    else console.warn('[check-regression] no comparable benches between baseline and current quick results.');
    printCoverage(comparison);

    const baselineMeta = baselineQuick.meta ?? baselineFile.meta;
    if (markdownPath !== undefined) {
        fs.writeFileSync(
            markdownPath,
            markdownReport(comparison, threshold, baselineMeta, current.meta, title)
        );
        console.log(`\nwrote ${markdownPath}`);
    }

    // Coverage before enforcement: an unmatched row is set membership, not a
    // measurement, so it holds on any machine — CI checks it (bench-smoke)
    // even though CI can never enforce a timing.
    if (requireBaselineRows && comparison.ungated.length > 0) {
        console.error(`\n[check-regression] FAIL: ${comparison.ungated.length} bench(es) have no baseline entry and therefore gate nothing:`);
        for (const bench of comparison.ungated) console.error(`  - ${bench}`);
        console.error('Re-baseline on a quiet machine (`pnpm bench:ssr:baseline`, or `node src/quick.ts --baseline` for the quick section alone) and commit results/baseline.json.');
        process.exit(1);
    }

    if (rows.length === 0) {
        console.warn('[check-regression] nothing to gate. Skipping.');
        process.exit(0);
    }

    const report = (r: DeltaRow): string =>
        `  - ${r.bench}: ${r.baselineP50Ms} -> ${r.currentP50Ms} ` +
        `(${formatDelta(r)}, threshold +${thresholdFor(r, threshold)}%)`;

    let failing = rows.filter((r) => isRegression(r, threshold));
    if (!enforce) {
        if (failing.length > 0) {
            console.log(`note: ${failing.length} bench(es) over threshold vs baseline (informational run — pass --enforce to gate):`);
            for (const r of failing) console.log(report(r));
        } else {
            console.log(`all benches within threshold (+${threshold}% timings, +${BYTES_THRESHOLD_PCT}% payload bytes).`);
        }
        return;
    }

    // Machine fingerprint: enforcing TIMINGS against numbers from different
    // hardware or a different Node major version would only produce false
    // alarms. Byte counts are machine-independent, so they keep gating —
    // a fatter payload is a real regression on any CPU.
    const currentCpu = os.cpus()[0]?.model ?? 'unknown';
    const foreignMachine = Boolean(
        baselineMeta &&
        (baselineMeta.cpu !== currentCpu || nodeMajor(baselineMeta.node) !== nodeMajor(process.version))
    );
    if (foreignMachine) {
        console.warn('[check-regression] machine fingerprint mismatch — skipping enforcement of TIMING benches:');
        console.warn(`  baseline: cpu="${baselineMeta!.cpu}", node=${baselineMeta!.node}`);
        console.warn(`  current:  cpu="${currentCpu}", node=${process.version}`);
        console.warn('  Re-baseline on this machine (`node src/quick.ts --baseline`) to enable them.');
        console.warn('  Payload-byte benches still gate — byte counts do not depend on the machine.');
        rows = rows.filter((r) => r.kind === 'bytes');
        failing = rows.filter((r) => isRegression(r, threshold));
    }

    if (failing.length === 0) {
        console.log('enforce: all benches within threshold.');
        return;
    }

    // Byte counts are deterministic — a re-run cannot absolve them, so they
    // fail straight away. Only timings get the noise filter.
    const failingBytes = failing.filter((r) => r.kind === 'bytes');
    if (failingBytes.length > 0) {
        console.error(`\n[check-regression] FAIL: ${failingBytes.length} payload-size bench(es) over +${BYTES_THRESHOLD_PCT}% vs baseline (deterministic — not noise):`);
        for (const r of failingBytes) console.error(report(r));
        console.error('If this payload growth is intentional, re-baseline with `node src/quick.ts --baseline` (or `pnpm bench:ssr:baseline`).');
        process.exit(1);
    }

    // Noise filter: re-run the whole quick suite once and re-compare before failing.
    console.log(`\nenforce: ${failing.length} bench(es) over threshold — re-running the quick suite once to filter out noise...\n`);
    const quickScript = fileURLToPath(new URL('./quick.ts', import.meta.url));
    // Forward execArgv (--conditions production etc.) — a bare re-run would
    // resolve sigx's dev dist and skew the enforcement decision.
    const rerun = spawnSync(process.execPath, [...process.execArgv, quickScript], { stdio: 'inherit' });
    if (rerun.status !== 0) {
        console.error('[check-regression] quick suite re-run failed.');
        process.exit(1);
    }

    const rerunResults = readJson<QuickPayload>(QUICK_LATEST, 'quick results (re-run)');
    comparison = compare(baselineQuick, rerunResults);
    rows = foreignMachine ? comparison.rows.filter((r) => r.kind === 'bytes') : comparison.rows;
    console.log('');
    printTable(rows);

    failing = rows.filter((r) => isRegression(r, threshold));
    if (failing.length > 0) {
        console.error(`\n[check-regression] FAIL: ${failing.length} bench(es) still over threshold vs baseline after re-run:`);
        for (const r of failing) console.error(report(r));
        console.error('If this regression is intentional, re-baseline with `node src/quick.ts --baseline` (or `pnpm bench:ssr:baseline`).');
        process.exit(1);
    }
    console.log('\nenforce: regression did not reproduce on re-run — treating as noise.');
}

main();
