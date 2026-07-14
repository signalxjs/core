# @sigx/benchmarks — comparative SSR benchmarks

Private workspace that benchmarks sigx server-side rendering against Vue,
React and Preact with equivalent component trees, plus a streaming TTFB
harness. Runner: [mitata](https://github.com/evanwashere/mitata).

## Prerequisites

The workspace deps `sigx` and `@sigx/server-renderer` resolve to their **built
dist** — build the repo first:

```sh
pnpm install
pnpm build          # at the repo root
```

## Commands (from the repo root)

```sh
pnpm bench:ssr            # verify equivalence, then run string-render benches (mitata)
pnpm bench:ssr:stream     # streaming TTFB harness (large-table, p50/p75/p99)
pnpm bench:ssr:quick      # sigx-only quick suite + regression check (informational)
pnpm bench:ssr:baseline   # full run that writes/merges results/baseline.json
pnpm --filter @sigx/benchmarks bench:quick:enforce   # quick suite, fails on >25% regression
pnpm --filter @sigx/benchmarks verify   # equivalence check only
```

## Scenarios

| Scenario           | Shape                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| `small-page`       | header/nav/cards/footer, ~50 elements                                   |
| `large-table-1k`   | Table → tbody → 1,000 Row components (6 td each, nested styled span)    |
| `large-table`      | same with 10,000 rows (also the streaming scenario)                     |
| `deep-tree`        | recursive component nesting, depth 12, branching 3                      |
| `attr-style-heavy` | 2,000 divs × 8 attributes incl. a style object                          |
| `escape-heavy`     | ~50KB article text dense in `&<>"'`                                     |
| `escape-clean`     | ~50KB article text with no escapable characters                         |

Every adapter builds the *same logical tree* from shared deterministic data
(`src/scenarios/data.ts`, seeded PRNG). `src/verify-equivalence.ts` proves it
before each bench run: per-tag histograms and entity-decoded text content must
match across all frameworks (HTML comments / hydration markers are normalized
away).

## Reading the output

- **String benches (mitata)**: one group per scenario, one bench per framework;
  lower time/iter is better. The summary block in each group ranks frameworks
  relative to the fastest. Raw numbers land in `results/latest.json`.
- **Streaming harness**: `console.table` with TTFB and total time p50/p75/p99
  in ms plus bytes written. Raw numbers land in `results/stream-latest.json`.
  TTFB = first chunk out of the node stream; for React the stream is piped on
  `onShellReady` so TTFB is the first shell write.

`NODE_ENV=production` is forced before adapters load so React and Vue use
their production builds — they branch at runtime. sigx picks dev vs prod at
*module resolution* via export conditions, so every bench script passes
`node --conditions production`; without it the dev dist (live
`process.env.NODE_ENV` reads per component) is measured and deep-tree looks
~4x slower than production reality.

## Quick regression suite (`bench:quick`)

`pnpm bench:ssr:quick` runs `src/quick.ts` + `src/check-regression.ts`: a
**sigx-only** suite (target well under 30s) covering `escape-heavy`,
`escape-clean`, `small-page` and `large-table-1k` via `renderToString` with a
reduced mitata sample budget, plus one streaming measurement (TTFB + total of
`renderToNodeStream(large-table-1k)`, 10 iterations). It writes
`results/quick-latest.json` and prints a delta table (baseline p50 vs current
p50, delta %) against the `quick` section of `results/baseline.json`.

- **Quick-vs-quick only**: the comparison uses the baseline's `quick` section
  (written by `node src/quick.ts --baseline`, included in
  `pnpm bench:ssr:baseline`) — never the full-suite numbers, which use a
  different sample budget.
- **Default is informational** (exit 0). `bench:quick:enforce` fails on any
  median regression worse than **+25%** — but first re-runs the quick suite
  once as a noise filter and only exits 1 if the regression persists.
  (`--threshold=<pct>` overrides the 25% for experiments.)
- **Fingerprint skip**: if the baseline's CPU model or Node *major* version
  differs from the current machine, enforcement is skipped with a warning —
  cross-machine deltas are meaningless.
- **Re-baseline** after *intentional* perf changes (and on the same machine
  the checks will run on): `node src/quick.ts --baseline`, or the full
  `pnpm bench:ssr:baseline`.
- **CI** (`.github/workflows/bench.yml`, manual trigger) runs the quick suite
  *without* `--enforce` and uploads `quick-latest.json` as an artifact —
  shared runners are far too noisy to gate on, so CI numbers are
  informational only.

## Baseline & caveats

`results/` is gitignored except `results/baseline.json`, which
`pnpm bench:ssr:baseline` produces (string + stream + quick sections + meta).

Re-baseline when: sigx SSR internals change intentionally, a competitor
dependency is bumped, or the benchmark scenarios themselves change.

**Machine fingerprint caveat**: numbers are only comparable on the same
hardware/OS/Node version. `meta` records date, Node version and CPU model —
treat cross-machine comparisons (and the committed baseline on different
hardware) as indicative only.
