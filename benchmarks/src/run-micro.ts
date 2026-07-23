/**
 * The full request-path micro run: every bench in every suite
 * (`src/micro/`), measured with mitata under the full sample budget, plus
 * the deterministic payload-byte metrics.
 *
 * sigx-only by design — there is no Vue/React equivalent of a server-function
 * endpoint or a boundary codec to compare against. The comparison that
 * carries meaning here is against a FLOOR: raw `JSON.stringify`, a bare fetch
 * handler, a plain render. Each bench declaring a `floorOf` is reported as a
 * ratio, which is the figure that survives a change of machine.
 *
 * Writes results/micro-latest.json; --baseline merges it into
 * results/baseline.json under `micro`.
 *
 * Run through `pnpm bench:micro` (or the workspace script) so it gets
 * `node --conditions production` — without it the DEV dist is measured, whose
 * warn branches this code path is full of.
 */
import { measure } from 'mitata';
import { SUITES } from './micro/index.ts';
import type { ByteMetric, MicroBench } from './micro/types.ts';
import { resultsMeta, writeResults, mergeBaseline, type ResultsMeta } from './results.ts';

export interface MicroBenchResult {
    suite: string;
    name: string;
    floorOf?: string;
    avgNs: number;
    p50Ns: number;
    samples: number;
    /** p50 relative to the declared floor's p50. Absent when there is no floor. */
    ratioToFloor?: number;
}

export interface MicroPayload {
    meta: ResultsMeta;
    benches: MicroBenchResult[];
    bytes: ByteMetric[];
}

function toMs(ns: number): string {
    return (ns / 1e6).toFixed(4);
}

/**
 * Run a bench's guard, surfacing a failure as a hard error. A bench that
 * cannot prove it is doing the work must not report a number at all — a
 * silent 403 or an empty render would look like a spectacular improvement.
 */
async function check(bench: MicroBench): Promise<void> {
    try {
        await bench.check();
    } catch (error) {
        console.error(`\n[bench] ${bench.suite}/${bench.name} FAILED its correctness guard:`);
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

async function main(): Promise<void> {
    const started = Date.now();
    const results: MicroBenchResult[] = [];
    const bytes: ByteMetric[] = [];

    for (const suite of SUITES) {
        console.log(`\n${suite.name}`);
        console.log('─'.repeat(suite.name.length));
        const benches = await suite.benches();
        const floorP50 = new Map<string, number>();

        for (const bench of benches) {
            await check(bench);
            const stats = await measure(() => bench.run());
            const result: MicroBenchResult = {
                suite: bench.suite,
                name: bench.name,
                ...(bench.floorOf ? { floorOf: bench.floorOf } : {}),
                avgNs: stats.avg,
                p50Ns: stats.p50,
                samples: stats.samples.length
            };
            floorP50.set(bench.name, stats.p50);
            if (bench.floorOf) {
                const floor = floorP50.get(bench.floorOf);
                if (floor === undefined) {
                    console.warn(`  ! floor "${bench.floorOf}" not measured before "${bench.name}" — no ratio`);
                } else {
                    result.ratioToFloor = Number((stats.p50 / floor).toFixed(3));
                }
            }
            results.push(result);
            const ratio = result.ratioToFloor !== undefined ? `  ${result.ratioToFloor}x floor` : '';
            console.log(`  ${bench.name.padEnd(40)} p50 ${toMs(stats.p50).padStart(10)} ms${ratio}`);
        }

        if (suite.bytes) {
            const metrics = await suite.bytes();
            bytes.push(...metrics);
            for (const metric of metrics) {
                console.log(`  ${`${metric.name} (bytes)`.padEnd(40)} ${String(metric.bytes).padStart(10)}`);
            }
        }
    }

    const meta = resultsMeta();
    const payload: MicroPayload = { meta, benches: results, bytes };
    const file = writeResults('micro-latest.json', payload);
    console.log(`\nwrote ${file} (suite took ${((Date.now() - started) / 1000).toFixed(1)}s)`);

    if (process.argv.includes('--baseline')) {
        console.log(`merged micro results into ${mergeBaseline('micro', payload, meta)}`);
    }
}

await main();
