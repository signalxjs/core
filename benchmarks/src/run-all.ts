/**
 * String-render benchmarks via mitata: one group per scenario, one bench per
 * framework. Writes results/latest.json; pass --baseline to also merge into
 * results/baseline.json.
 */
import { run, bench, group, summary } from 'mitata';
import { loadAdapters } from './load-adapters.ts';
import type { ScenarioName } from './adapters/types.ts';
import { resultsMeta, writeResults, mergeBaseline } from './results.ts';

const SCENARIOS: ScenarioName[] = [
    'small-page', 'large-table-1k', 'large-table', 'deep-tree',
    'attr-style-heavy', 'escape-heavy', 'escape-clean'
];

const adapters = await loadAdapters();

for (const scenario of SCENARIOS) {
    group(scenario, () => {
        summary(() => {
            for (const adapter of adapters) {
                bench(adapter.name, async () => {
                    await adapter.renderToString(scenario);
                });
            }
        });
    });
}

const trial = await run();

// Reduce mitata's trial object to a serializable summary per group/bench.
// `b.group` is a numeric collection id; the (untyped) `layout` array on the
// run() result maps it back to the group name we passed (the scenario).
const layout = (trial as unknown as { layout: Array<{ name: string | number | null }> }).layout;
const results = trial.benchmarks.map((b: any) => {
    const stats = b.runs?.[0]?.stats ?? {};
    return {
        scenario: layout?.[b.group]?.name ?? null,
        framework: b.alias,
        stats: {
            avgNs: stats.avg ?? null,
            minNs: stats.min ?? null,
            maxNs: stats.max ?? null,
            p25Ns: stats.p25 ?? null,
            p50Ns: stats.p50 ?? null,
            p75Ns: stats.p75 ?? null,
            p99Ns: stats.p99 ?? null,
            samples: stats.samples?.length ?? null
        }
    };
});

const meta = resultsMeta();
const file = writeResults('latest.json', { meta, results });
console.log(`\nwrote ${file}`);

if (process.argv.includes('--baseline')) {
    const baselineFile = mergeBaseline('string', results, meta);
    console.log(`merged string results into ${baselineFile}`);
}
