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

interface DeltaRow {
    bench: string;
    baselineP50Ms: number;
    currentP50Ms: number;
    deltaPct: number;
    /** Byte-count rows are machine-independent — gated tighter, never skipped. */
    kind: 'time' | 'bytes';
}

function thresholdFor(row: DeltaRow, timingThreshold: number): number {
    return row.kind === 'bytes' ? BYTES_THRESHOLD_PCT : timingThreshold;
}

function isRegression(row: DeltaRow, timingThreshold: number): boolean {
    return row.deltaPct > thresholdFor(row, timingThreshold);
}

function readJson<T>(file: string, what: string): T {
    if (!fs.existsSync(file)) {
        console.error(`[check-regression] ${what} not found: ${file}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function thresholdPct(): number {
    const arg = process.argv.find((a) => a.startsWith('--threshold='));
    if (!arg) return DEFAULT_THRESHOLD_PCT;
    const value = Number(arg.slice('--threshold='.length));
    if (!Number.isFinite(value) || value <= 0) {
        console.error(`[check-regression] invalid --threshold value: ${arg}`);
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

function compare(baseline: QuickPayload, current: QuickPayload): DeltaRow[] {
    const rows: DeltaRow[] = [];
    for (const cur of current.string) {
        const base = baseline.string.find(
            (b) => b.scenario === cur.scenario && b.framework === cur.framework
        );
        if (!base) continue;
        rows.push({
            bench: `${cur.scenario} (string)`,
            baselineP50Ms: Number((base.stats.p50Ns / 1e6).toFixed(3)),
            currentP50Ms: Number((cur.stats.p50Ns / 1e6).toFixed(3)),
            deltaPct: deltaPct(base.stats.p50Ns, cur.stats.p50Ns),
            kind: 'time'
        });
    }
    for (const cur of current.stream.results) {
        const base = baseline.stream.scenario === current.stream.scenario
            ? baseline.stream.results.find((b) => b.framework === cur.framework)
            : undefined;
        if (!base) continue;
        rows.push({
            bench: `${current.stream.scenario} (stream ttfb)`,
            baselineP50Ms: base.ttfbMs.p50,
            currentP50Ms: cur.ttfbMs.p50,
            deltaPct: deltaPct(base.ttfbMs.p50, cur.ttfbMs.p50),
            kind: 'time'
        });
        rows.push({
            bench: `${current.stream.scenario} (stream total)`,
            baselineP50Ms: base.totalMs.p50,
            currentP50Ms: cur.totalMs.p50,
            deltaPct: deltaPct(base.totalMs.p50, cur.totalMs.p50),
            kind: 'time'
        });
    }
    // Request-path timings. A baseline recorded before these existed simply
    // has no `micro` section and contributes no rows.
    for (const cur of current.micro ?? []) {
        const base = (baseline.micro ?? []).find(
            (b) => b.suite === cur.suite && b.name === cur.name
        );
        if (!base) continue;
        rows.push({
            bench: `${cur.suite}/${cur.name}`,
            baselineP50Ms: Number((base.stats.p50Ns / 1e6).toFixed(4)),
            currentP50Ms: Number((cur.stats.p50Ns / 1e6).toFixed(4)),
            deltaPct: deltaPct(base.stats.p50Ns, cur.stats.p50Ns),
            kind: 'time'
        });
    }
    // Payload sizes — the `ms` columns carry BYTES for these rows (the table
    // is shared); `kind` is what the threshold and the fingerprint skip read.
    for (const cur of current.bytes ?? []) {
        const base = (baseline.bytes ?? []).find(
            (b) => b.suite === cur.suite && b.name === cur.name
        );
        if (!base) continue;
        rows.push({
            bench: `${cur.suite}/${cur.name} (bytes)`,
            baselineP50Ms: base.bytes,
            currentP50Ms: cur.bytes,
            deltaPct: deltaPct(base.bytes, cur.bytes),
            kind: 'bytes'
        });
    }
    return rows;
}

function printTable(rows: DeltaRow[]): void {
    console.table(rows.map((r) => ({
        bench: r.bench,
        'baseline (ms|bytes)': r.baselineP50Ms,
        'current (ms|bytes)': r.currentP50Ms,
        'delta %': `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`
    })));
}

function main(): void {
    const enforce = process.argv.includes('--enforce');
    const threshold = thresholdPct();

    const baselineFile = readJson<Record<string, unknown> & { meta?: ResultsMeta; quick?: QuickPayload }>(BASELINE, 'baseline');
    const current = readJson<QuickPayload>(QUICK_LATEST, 'quick results');

    const baselineQuick = baselineFile.quick;
    if (!baselineQuick) {
        console.warn('[check-regression] baseline.json has no `quick` section — run `node src/quick.ts --baseline` (or `pnpm bench:ssr:baseline`) on this machine first. Skipping comparison.');
        process.exit(0);
    }

    let rows = compare(baselineQuick, current);
    if (rows.length === 0) {
        console.warn('[check-regression] no comparable benches between baseline and current quick results. Skipping.');
        process.exit(0);
    }
    printTable(rows);

    const report = (r: DeltaRow): string =>
        `  - ${r.bench}: ${r.baselineP50Ms} -> ${r.currentP50Ms} ` +
        `(${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%, ` +
        `threshold +${thresholdFor(r, threshold)}%)`;

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
    const baselineMeta = baselineQuick.meta ?? baselineFile.meta;
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
    rows = compare(baselineQuick, rerunResults);
    if (foreignMachine) rows = rows.filter((r) => r.kind === 'bytes');
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
