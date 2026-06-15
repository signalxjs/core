/**
 * Quick sigx-only regression suite (target <30s total): four string-render
 * scenarios measured with mitata's measure() under a reduced sample budget
 * (mitata's default is ~642ms of measured CPU time per bench; we cut that
 * down), plus one streaming measurement (renderToNodeStream of
 * large-table-1k, TTFB + total over a handful of iterations).
 *
 * Writes results/quick-latest.json. Pass --baseline to also merge the data
 * into results/baseline.json under the `quick` key, so check-regression.ts
 * compares quick-vs-quick numbers (the full suite uses a different sample
 * budget and is not comparable).
 */
import { measure } from 'mitata';
import { loadSigx } from './load-adapters.ts';
import type { ScenarioName } from './adapters/types.ts';
import { resultsMeta, writeResults, mergeBaseline, type ResultsMeta } from './results.ts';

const STRING_SCENARIOS: ScenarioName[] = ['escape-heavy', 'escape-clean', 'small-page', 'large-table-1k'];
const STREAM_SCENARIO: ScenarioName = 'large-table-1k';
const STREAM_WARMUP = 3;
const STREAM_ITERATIONS = 10;

// Reduced sample budget: at least 16 samples, stop after ~250ms of measured
// CPU time per bench (vs mitata's 642ms default). Keeps the suite quick while
// the median stays stable enough for a 25% regression gate.
const MEASURE_OPTS = { min_samples: 16, min_cpu_time: 250 * 1e6 };

export interface QuickStringResult {
    scenario: ScenarioName;
    framework: string;
    stats: { avgNs: number; p50Ns: number; samples: number };
}

export interface QuickStreamResult {
    scenario: ScenarioName;
    warmup: number;
    iterations: number;
    results: Array<{
        framework: string;
        bytes: number;
        ttfbMs: { p50: number };
        totalMs: { p50: number };
    }>;
}

export interface QuickPayload {
    meta: ResultsMeta;
    string: QuickStringResult[];
    stream: QuickStreamResult;
}

function medianNs(samples: bigint[]): bigint {
    const sorted = [...samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sorted[Math.floor((sorted.length - 1) / 2)];
}

function toMs(ns: bigint | number): number {
    return Number((Number(ns) / 1e6).toFixed(3));
}

async function main(): Promise<void> {
    const started = Date.now();
    const sigx = await loadSigx();

    console.log(`quick suite — sigx only, reduced sample budget (min ${MEASURE_OPTS.min_samples} samples / ~${MEASURE_OPTS.min_cpu_time / 1e6}ms CPU per bench)\n`);

    const stringResults: QuickStringResult[] = [];
    for (const scenario of STRING_SCENARIOS) {
        const stats = await measure(() => sigx.renderToString(scenario), MEASURE_OPTS);
        stringResults.push({
            scenario,
            framework: sigx.name,
            stats: { avgNs: stats.avg, p50Ns: stats.p50, samples: stats.samples.length }
        });
        console.log(`  ${scenario.padEnd(16)} p50 ${toMs(stats.p50).toFixed(3).padStart(8)} ms  (${stats.samples.length} samples)`);
    }

    for (let i = 0; i < STREAM_WARMUP; i++) {
        await sigx.renderStream!(STREAM_SCENARIO);
    }
    const ttfbs: bigint[] = [];
    const totals: bigint[] = [];
    let bytes = 0;
    for (let i = 0; i < STREAM_ITERATIONS; i++) {
        const sample = await sigx.renderStream!(STREAM_SCENARIO);
        ttfbs.push(sample.ttfbNs);
        totals.push(sample.totalNs);
        bytes = sample.bytes;
    }
    const stream: QuickStreamResult = {
        scenario: STREAM_SCENARIO,
        warmup: STREAM_WARMUP,
        iterations: STREAM_ITERATIONS,
        results: [{
            framework: sigx.name,
            bytes,
            ttfbMs: { p50: toMs(medianNs(ttfbs)) },
            totalMs: { p50: toMs(medianNs(totals)) }
        }]
    };
    console.log(`  ${`${STREAM_SCENARIO} (stream)`.padEnd(16)} ttfb p50 ${stream.results[0].ttfbMs.p50} ms, total p50 ${stream.results[0].totalMs.p50} ms  (${STREAM_ITERATIONS} iterations)`);

    const meta = resultsMeta();
    const payload: QuickPayload = { meta, string: stringResults, stream };
    const file = writeResults('quick-latest.json', payload);
    console.log(`\nwrote ${file} (suite took ${((Date.now() - started) / 1000).toFixed(1)}s)`);

    if (process.argv.includes('--baseline')) {
        const baselineFile = mergeBaseline('quick', payload, meta);
        console.log(`merged quick results into ${baselineFile}`);
    }
}

await main();
