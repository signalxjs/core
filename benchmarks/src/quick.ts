/**
 * Quick sigx-only regression suite (target <30s total): four string-render
 * scenarios measured with mitata's measure() under a reduced sample budget
 * (mitata's default is ~642ms of measured CPU time per bench; we cut that
 * down), plus one streaming measurement (renderToNodeStream of
 * large-table-1k, TTFB + total over a handful of iterations), plus the
 * reduced request-path subset from `src/micro/` (server functions, the
 * boundary codec, the §6.3 gate, the SSR packs) and the packs' deterministic
 * payload sizes.
 *
 * Writes results/quick-latest.json. Pass --baseline to also merge the data
 * into results/baseline.json under the `quick` key, so check-regression.ts
 * compares quick-vs-quick numbers (the full suite uses a different sample
 * budget and is not comparable).
 */
import { measure } from 'mitata';
import { loadSigx } from './load-adapters.ts';
import type { ScenarioName } from './adapters/types.ts';
import { SUITES } from './micro/index.ts';
import type { ByteMetric } from './micro/types.ts';
import { resultsMeta, writeResults, mergeBaseline, type ResultsMeta } from './results.ts';

const STRING_SCENARIOS: ScenarioName[] = ['escape-heavy', 'escape-clean', 'small-page', 'large-table-1k'];
const STREAM_SCENARIO: ScenarioName = 'large-table-1k';
const STREAM_WARMUP = 3;
const STREAM_ITERATIONS = 10;

// Reduced sample budget: at least 16 samples, stop after ~400ms of measured
// CPU time per bench (vs mitata's 642ms default). The 400ms (up from 250ms,
// #474) firms up the median for the ~0.5–2ms benches the gated picks now
// favour — more CPU, more samples, steadier p50. It does NOT rescue the
// sub-0.1ms SSR string benches (escape-clean, small-page): at that size timer
// resolution dominates the p50, not the code, so it swings past +25% run to
// run no matter the sample budget — check-regression treats those two as
// INFORMATIONAL (measured and printed, never gated). The gated request-path
// picks are all larger, stable siblings.
const MEASURE_OPTS = { min_samples: 16, min_cpu_time: 400 * 1e6 };

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

/** One request-path bench from the reduced micro subset (`quick: true`). */
export interface QuickMicroResult {
    suite: string;
    name: string;
    stats: { avgNs: number; p50Ns: number; samples: number };
}

export interface QuickPayload {
    meta: ResultsMeta;
    string: QuickStringResult[];
    stream: QuickStreamResult;
    /** Request-path timings (`src/micro/`) — gated like the string benches. */
    micro?: QuickMicroResult[];
    /** Deterministic payload sizes — gated tighter, never fingerprint-skipped. */
    bytes?: ByteMetric[];
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
    // The gated request-path picks below deliberately favour the larger, more
    // stable benches — a p50 on a sub-millisecond bench swings by tens of
    // percent between runs, which is noise, not signal (#474).

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

    // The request-path subset (server functions, codec, the §6.3 gate, the
    // packs) — the same bench definitions the full micro run uses, filtered
    // to the ones marked `quick`, under the same reduced budget as above.
    const micro: QuickMicroResult[] = [];
    const byteMetrics: ByteMetric[] = [];
    for (const suite of SUITES) {
        for (const bench of (await suite.benches()).filter((b) => b.quick)) {
            try {
                await bench.check();
            } catch (error) {
                console.error(`\n[quick] ${bench.suite}/${bench.name} FAILED its correctness guard:`);
                console.error(`  ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
            const stats = await measure(() => bench.run(), MEASURE_OPTS);
            micro.push({
                suite: bench.suite,
                name: bench.name,
                stats: { avgNs: stats.avg, p50Ns: stats.p50, samples: stats.samples.length }
            });
            console.log(`  ${`${bench.suite}/${bench.name}`.padEnd(40)} p50 ${toMs(stats.p50).toFixed(4).padStart(9)} ms`);
        }
        if (suite.bytes) byteMetrics.push(...(await suite.bytes()));
    }
    for (const metric of byteMetrics) {
        console.log(`  ${`${metric.suite}/${metric.name} (bytes)`.padEnd(40)} ${String(metric.bytes).padStart(9)}`);
    }

    const meta = resultsMeta();
    const payload: QuickPayload = { meta, string: stringResults, stream, micro, bytes: byteMetrics };
    const file = writeResults('quick-latest.json', payload);
    console.log(`\nwrote ${file} (suite took ${((Date.now() - started) / 1000).toFixed(1)}s)`);

    if (process.argv.includes('--baseline')) {
        const baselineFile = mergeBaseline('quick', payload, meta);
        console.log(`merged quick results into ${baselineFile}`);
    }
}

await main();
