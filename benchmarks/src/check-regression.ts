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
 * Machine fingerprint: if the baseline was recorded on a different CPU model
 * or Node major version, the numbers are not comparable — a warning is
 * printed and enforcement is skipped (exit 0).
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

interface DeltaRow {
    bench: string;
    baselineP50Ms: number;
    currentP50Ms: number;
    deltaPct: number;
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
            deltaPct: deltaPct(base.stats.p50Ns, cur.stats.p50Ns)
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
            deltaPct: deltaPct(base.ttfbMs.p50, cur.ttfbMs.p50)
        });
        rows.push({
            bench: `${current.stream.scenario} (stream total)`,
            baselineP50Ms: base.totalMs.p50,
            currentP50Ms: cur.totalMs.p50,
            deltaPct: deltaPct(base.totalMs.p50, cur.totalMs.p50)
        });
    }
    return rows;
}

function printTable(rows: DeltaRow[]): void {
    console.table(rows.map((r) => ({
        bench: r.bench,
        'baseline p50 (ms)': r.baselineP50Ms,
        'current p50 (ms)': r.currentP50Ms,
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

    let failing = rows.filter((r) => r.deltaPct > threshold);
    if (!enforce) {
        if (failing.length > 0) {
            console.log(`note: ${failing.length} bench(es) worse than +${threshold}% vs baseline (informational run — pass --enforce to gate).`);
        } else {
            console.log(`all benches within +${threshold}% of baseline.`);
        }
        return;
    }

    // Machine fingerprint: enforcing against numbers from different hardware
    // or a different Node major version would only produce false alarms.
    const baselineMeta = baselineQuick.meta ?? baselineFile.meta;
    const currentCpu = os.cpus()[0]?.model ?? 'unknown';
    if (baselineMeta && (baselineMeta.cpu !== currentCpu || nodeMajor(baselineMeta.node) !== nodeMajor(process.version))) {
        console.warn('[check-regression] machine fingerprint mismatch — skipping enforcement:');
        console.warn(`  baseline: cpu="${baselineMeta.cpu}", node=${baselineMeta.node}`);
        console.warn(`  current:  cpu="${currentCpu}", node=${process.version}`);
        console.warn('  Re-baseline on this machine (`node src/quick.ts --baseline`) to enable enforcement.');
        process.exit(0);
    }

    if (failing.length === 0) {
        console.log(`enforce: all benches within +${threshold}% of baseline.`);
        return;
    }

    // Noise filter: re-run the whole quick suite once and re-compare before failing.
    console.log(`\nenforce: ${failing.length} bench(es) worse than +${threshold}% — re-running the quick suite once to filter out noise...\n`);
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
    console.log('');
    printTable(rows);

    failing = rows.filter((r) => r.deltaPct > threshold);
    if (failing.length > 0) {
        console.error(`\n[check-regression] FAIL: ${failing.length} bench(es) still worse than +${threshold}% vs baseline after re-run:`);
        for (const r of failing) {
            console.error(`  - ${r.bench}: ${r.baselineP50Ms} ms -> ${r.currentP50Ms} ms (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%)`);
        }
        console.error('If this regression is intentional, re-baseline with `node src/quick.ts --baseline` (or `pnpm bench:ssr:baseline`).');
        process.exit(1);
    }
    console.log('\nenforce: regression did not reproduce on re-run — treating as noise.');
}

main();
