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
pnpm bench:ssr:baseline   # full run that writes/merges results/baseline.json
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
their production builds.

## Baseline & caveats

`results/` is gitignored except `results/baseline.json`, which
`pnpm bench:ssr:baseline` produces (string + stream sections + meta).

Re-baseline when: sigx SSR internals change intentionally, a competitor
dependency is bumped, or the benchmark scenarios themselves change.

**Machine fingerprint caveat**: numbers are only comparable on the same
hardware/OS/Node version. `meta` records date, Node version and CPU model —
treat cross-machine comparisons (and the committed baseline on different
hardware) as indicative only.
