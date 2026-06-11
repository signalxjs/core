/**
 * Streaming TTFB harness (hand-rolled, not mitata): for every streaming-capable
 * adapter, render `large-table` 5 warmup + 30 measured times and report
 * p50/p75/p99 TTFB and total time. Pass --baseline to also merge the data into
 * results/baseline.json.
 */
import { loadAdapters } from './load-adapters.ts';
import type { ScenarioName } from './adapters/types.ts';
import { resultsMeta, writeResults, mergeBaseline } from './results.ts';

const SCENARIO: ScenarioName = 'large-table';
const WARMUP = 5;
const ITERATIONS = 30;

function percentile(sortedNs: bigint[], p: number): bigint {
    const idx = Math.min(sortedNs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNs.length) - 1));
    return sortedNs[idx];
}

function toMs(ns: bigint): number {
    return Number((Number(ns) / 1e6).toFixed(3));
}

interface FrameworkStreamResult {
    framework: string;
    bytes: number;
    ttfbMs: { p50: number; p75: number; p99: number };
    totalMs: { p50: number; p75: number; p99: number };
}

async function main(): Promise<void> {
    const adapters = (await loadAdapters()).filter((a) => a.renderStream);
    console.log(`Streaming TTFB — scenario: ${SCENARIO}, ${WARMUP} warmup + ${ITERATIONS} measured iterations\n`);

    const results: FrameworkStreamResult[] = [];
    for (const adapter of adapters) {
        for (let i = 0; i < WARMUP; i++) {
            await adapter.renderStream!(SCENARIO);
        }
        const ttfbs: bigint[] = [];
        const totals: bigint[] = [];
        let bytes = 0;
        for (let i = 0; i < ITERATIONS; i++) {
            const sample = await adapter.renderStream!(SCENARIO);
            ttfbs.push(sample.ttfbNs);
            totals.push(sample.totalNs);
            bytes = sample.bytes;
        }
        ttfbs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        totals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        results.push({
            framework: adapter.name,
            bytes,
            ttfbMs: { p50: toMs(percentile(ttfbs, 50)), p75: toMs(percentile(ttfbs, 75)), p99: toMs(percentile(ttfbs, 99)) },
            totalMs: { p50: toMs(percentile(totals, 50)), p75: toMs(percentile(totals, 75)), p99: toMs(percentile(totals, 99)) }
        });
    }

    console.table(results.map((r) => ({
        framework: r.framework,
        'ttfb p50 (ms)': r.ttfbMs.p50,
        'ttfb p75 (ms)': r.ttfbMs.p75,
        'ttfb p99 (ms)': r.ttfbMs.p99,
        'total p50 (ms)': r.totalMs.p50,
        'total p75 (ms)': r.totalMs.p75,
        'total p99 (ms)': r.totalMs.p99,
        bytes: r.bytes
    })));

    const meta = resultsMeta();
    const payload = { meta, scenario: SCENARIO, warmup: WARMUP, iterations: ITERATIONS, results };
    const file = writeResults('stream-latest.json', payload);
    console.log(`\nwrote ${file}`);

    if (process.argv.includes('--baseline')) {
        const baselineFile = mergeBaseline('stream', { scenario: SCENARIO, warmup: WARMUP, iterations: ITERATIONS, results }, meta);
        console.log(`merged stream results into ${baselineFile}`);
    }
}

await main();
