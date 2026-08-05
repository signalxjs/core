/**
 * The interleaved A/B driver: measure two checkouts alternately, several
 * rounds, and write every round's raw payloads for `ab-report.ts` to interpret.
 *
 * Why interleave at all (#638). The previous A/B measured the base ref once,
 * then the head ref once. That puts every source of between-run variance —
 * machine drift, thermal state, page-cache and JIT warmth, a noisy neighbour —
 * squarely on the head side's account, because the head is always second. On
 * #637, a PR that changed no package source at all, that read as +3.7%, +5.9%
 * and +6.6% on three rows. Nothing had regressed; the head was simply measured
 * second.
 *
 * Raising mitata's sample budget cannot fix this. That shrinks WITHIN-run
 * sampling error, and the problem is BETWEEN-run variance: every sample on one
 * side shares the same position in time, so more of them just measures the same
 * drift more precisely.
 *
 * So: alternate, and COUNTERBALANCE the alternation. Round r measures
 * [base, head] when r is even and [head, base] when odd. Under a linear drift
 * the two orders carry equal and opposite bias, so it cancels to first order in
 * the paired deltas rather than accruing to one side. An A/B/A/B schedule that
 * never swaps would leave base systematically earlier in every round and
 * reproduce the original bias in miniature.
 *
 * Each side runs ITS OWN quick.ts, from its own checkout, exactly as the
 * previous job did. The base ref is an arbitrary older commit whose suite need
 * not contain benches the head introduces, and rows that exist on only one side
 * must keep falling out as `ungated` / `stale` rather than being force-matched.
 *
 * Deliberately dependency-free and free of local imports: payloads are opaque
 * JSON here and only `ab-report.ts` interprets them. `signalxjs/actors` carries
 * its own copy of bench.yml and a differently-shaped quick suite, so this file
 * should drop in there unchanged.
 *
 * Usage:
 *   node --conditions production benchmarks/src/ab.ts \
 *     --base-dir=<path> --head-dir=<path> [--rounds=5] --out=<path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_ROUNDS = 5;

type Side = 'base' | 'head';

interface RoundResult {
    index: number;
    /** The order this round actually ran in — counterbalancing is data, not a convention. */
    order: Side[];
    base: unknown;
    head: unknown;
}

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
    console.error(`[ab] ${message}`);
    process.exit(1);
}

function requireDir(name: string): string {
    const dir = argValue(name);
    if (!dir) fail(`missing --${name}=<path>`);
    if (!fs.existsSync(path.join(dir, 'benchmarks', 'src', 'quick.ts'))) {
        fail(`--${name}=${dir} does not look like a checkout (no benchmarks/src/quick.ts)`);
    }
    return dir;
}

function rounds(): number {
    const raw = argValue('rounds');
    if (raw === undefined) return DEFAULT_ROUNDS;
    const value = Number(raw);
    // Two rounds is the minimum that can counterbalance; one round is just the
    // old sequential A/B wearing a new name, and the verdict rules would read a
    // single paired delta as unanimous.
    if (!Number.isInteger(value) || value < 2) {
        fail(`--rounds must be an integer >= 2, got: ${raw}`);
    }
    return value;
}

/**
 * Run one side's quick suite in its own checkout and return the payload it
 * wrote. `process.execArgv` is forwarded so `--conditions production` survives
 * into the child — without it the child resolves the DEV dist, whose warn
 * branches would be measured instead of the shipping code.
 */
function measure(side: Side, dir: string, round: number): unknown {
    const script = path.join(dir, 'benchmarks', 'src', 'quick.ts');
    const started = Date.now();
    console.log(`\n[ab] round ${round + 1} — ${side}`);
    const run = spawnSync(process.execPath, [...process.execArgv, script], {
        cwd: dir,
        stdio: 'inherit'
    });
    if (run.error) fail(`round ${round + 1} ${side}: could not start quick.ts — ${run.error.message}`);
    if (run.status !== 0) {
        // A partial A/B is worse than none: a missing round silently changes
        // what "all rounds agree" means in the verdict.
        fail(`round ${round + 1} ${side}: quick.ts exited ${run.status}`);
    }
    const resultFile = path.join(dir, 'benchmarks', 'results', 'quick-latest.json');
    if (!fs.existsSync(resultFile)) fail(`round ${round + 1} ${side}: quick.ts wrote no ${resultFile}`);
    console.log(`[ab] round ${round + 1} ${side} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

function main(): void {
    const baseDir = requireDir('base-dir');
    const headDir = requireDir('head-dir');
    const out = argValue('out');
    if (!out) fail('missing --out=<path>');
    const totalRounds = rounds();

    console.log(`[ab] ${totalRounds} interleaved rounds, counterbalanced (even rounds base-first, odd rounds head-first)`);
    console.log(`[ab] base: ${baseDir}`);
    console.log(`[ab] head: ${headDir}`);

    const results: RoundResult[] = [];
    for (let round = 0; round < totalRounds; round++) {
        const order: Side[] = round % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
        const payloads: Partial<Record<Side, unknown>> = {};
        for (const side of order) {
            payloads[side] = measure(side, side === 'base' ? baseDir : headDir, round);
        }
        results.push({ index: round, order, base: payloads.base, head: payloads.head });
    }

    fs.writeFileSync(out, JSON.stringify({ rounds: results }, null, 2));
    console.log(`\n[ab] wrote ${out} (${results.length} rounds)`);
}

main();
