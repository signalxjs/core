/**
 * The Node side of the Velt POC: renders the benchmark scenarios through
 * sigx's own SSR (`@sigx/server-renderer`, built prod dist) and
 *   - writes each scenario's HTML to out/node/<scenario>.html, the reference
 *     the Velt renderer must match byte for byte;
 *   - prints one JSON line per scenario with the median render time.
 *
 * The trees come from benchmarks/src/scenarios/build.ts, the same ones the
 * comparative SSR suite measures. Run with `node --conditions production`
 * (see run.sh): a bare `node` measures the dev build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from '@sigx/server-renderer/server';
import { build } from '../../../benchmarks/src/scenarios/build.ts';

const SCENARIOS = ['small-page', 'large-table-1k', 'large-table', 'deep-tree'] as const;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out', 'node');
mkdirSync(outDir, { recursive: true });

const iterations = Number(process.argv[2] ?? '20');

for (const scenario of SCENARIOS) {
    const html = await renderToString(build(scenario));
    writeFileSync(join(outDir, `${scenario}.html`), html);
    // Fewer rounds for the 12.5 MB deep tree; warm up before timing.
    const rounds = scenario === 'deep-tree' ? Math.max(3, iterations / 5) : iterations;
    for (let i = 0; i < 3; i++) await renderToString(build(scenario));
    const times: number[] = [];
    for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        await renderToString(build(scenario));
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(JSON.stringify({ runtime: 'node', scenario, bytes: Buffer.byteLength(html), ms: median }));
}
