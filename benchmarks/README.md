# @sigx/benchmarks — SSR + request-path benchmarks

Private workspace with two families of benchmark, both run by
[mitata](https://github.com/evanwashere/mitata):

- **Comparative SSR** — sigx server-side rendering against Vue, React and
  Preact with equivalent component trees, plus a streaming TTFB harness.
- **Request path** (`src/micro/`) — sigx-only benches of the code every
  request touches: the server-function endpoint, the boundary codec, the §6.3
  boundary-refresh gate, and the SSR packs. There is no Vue/React equivalent
  of an RPC endpoint or a boundary codec to compare against, so these measure
  against a **floor** instead (see below).

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
pnpm bench:micro          # request-path suites (server fns, codec, gate, packs)
pnpm bench:ssr:quick      # sigx-only quick suite + regression check (informational)
pnpm bench:ssr:baseline   # full run that writes/merges results/baseline.json
pnpm --filter @sigx/benchmarks bench:quick:enforce   # quick suite, fails on regression
pnpm --filter @sigx/benchmarks verify       # equivalence check only
pnpm --filter @sigx/benchmarks typecheck    # this workspace's own stricter tsconfig
```

`typecheck` is not covered by the root `pnpm typecheck` (its program is
`packages/` only). It matters here because these files run through node's
**strip-only** type stripping, so the workspace tsconfig sets
`erasableSyntaxOnly` — parameter properties, enums and namespaces compile
fine under the root config and crash at run time. CI runs it in the
`bench-smoke` job.

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
(`src/scenarios/data.ts`, seeded PRNG; the sigx trees themselves live in
`src/scenarios/build.ts`, shared with the packs suite).
`src/verify-equivalence.ts` proves it before each bench run: per-tag
histograms and entity-decoded text content must match across all frameworks
(HTML comments / hydration markers are normalized away).

## Request-path benches (`bench:micro`)

`pnpm bench:micro` runs `src/run-micro.ts` over five suites in `src/micro/`.
Payloads come from `src/fixtures/payloads.ts`, derived from the same seeded
data as the scenarios.

| Suite      | What it measures                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `codec`    | `@sigx/serialize` encode/revive over plain, rich (Date/Map/Set/BigInt/URL) and deeply nested payloads             |
| `serverfn` | `handleServerFnRequest` in process: POST read/mutation, GET idempotent read, NDJSON stream, the error path        |
| `keymatch` | the §6.3 boundary-refresh admission gate — `deps × patterns` matching, swept by size, tuple vs string patterns    |
| `refresh`  | `createBoundaryRefresh` re-rendering 1 / 8 / 32 descriptors                                                       |
| `packs`    | a scenario rendered plain vs `islandsPlugin()` vs `resumePlugin()` — time **and** payload bytes                   |

### Floors, not competitors

A bench declaring `floorOf` is reported as a **ratio to its floor** — the
irreducible version of the same work: raw `JSON.stringify`/`JSON.parse` for
the codec, a bare "read JSON, answer JSON" fetch handler for the endpoint, a
plain render for the packs. The ratio is what a fix has to move, and unlike an
absolute millisecond figure it stays meaningful on a different machine.

### Correctness guards

Every bench carries a `check()` that runs once before it is measured and
fails the whole run on a throw. This is not decoration: a bench that silently
measured a 403, an empty render, or a pack that failed to install would report
a spectacular number forever. The guards assert response status and envelope
contents, that the §6.3 gate actually admitted every descriptor, that the
codec round-trips its fixture, and that each pack left its fingerprint in the
HTML (`"hydrate":"load"` for islands, `"hydrate":"never"` + `"component"` for
resume) while the plain floor left none.

### Payload bytes

The packs suite also reports byte counts of the rendered output. Those are
deterministic — no sampling, identical on every machine — so they are gated
far tighter than timings (+2%) and are enforced even when the baseline came
from different hardware. A pack that starts emitting a fatter boundary table
is a real, user-visible regression that no timing gate would catch.

## Reading the output

- **String benches (mitata)**: one group per scenario, one bench per framework;
  lower time/iter is better. The summary block in each group ranks frameworks
  relative to the fastest. Raw numbers land in `results/latest.json`.
- **Streaming harness**: `console.table` with TTFB and total time p50/p75/p99
  in ms plus bytes written. Raw numbers land in `results/stream-latest.json`.
  TTFB = first chunk out of the node stream; for React the stream is piped on
  `onShellReady` so TTFB is the first shell write.
- **Request-path benches**: one block per suite, p50 per bench plus `Nx floor`
  where a floor is declared, then the packs' byte counts. Raw numbers land in
  `results/micro-latest.json`.

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
`renderToNodeStream(large-table-1k)`, 10 iterations), plus the request-path
benches marked `quick: true` in `src/micro/` and the packs' payload byte
counts. It writes `results/quick-latest.json` and prints a delta table
against the `quick` section of `results/baseline.json`.

- **Quick-vs-quick only**: the comparison uses the baseline's `quick` section
  (written by `node src/quick.ts --baseline`, included in
  `pnpm bench:ssr:baseline`) — never the full-suite numbers, which use a
  different sample budget.
- **Default is informational** (exit 0). `bench:quick:enforce` fails on any
  median regression worse than **+25%** — but first re-runs the quick suite
  once as a noise filter and only exits 1 if the regression persists.
  (`--threshold=<pct>` overrides the 25% for experiments.)
- **Payload-byte rows gate differently**: +2%, no noise re-run (a byte count
  cannot be noise), and no fingerprint skip.
- **Timing picks favour larger, stable benches (#474).** A p50 on a
  sub-millisecond bench swings tens of percent between runs — noise, not
  signal — so the request-path benches marked `quick` are the larger, stable
  siblings (the `keymatch`/`refresh` worst-case shapes, the `large-table-1k`
  pack render), and the measure budget is ~400ms of CPU per bench to firm up
  the mid-range benches' medians. The two sub-0.1ms SSR string benches
  (`small-page`, `escape-clean`) can't be steadied at all — at that size timer
  resolution dominates the p50, not the code, so no sample budget helps — so
  `check-regression` marks them **informational**: measured and printed with an
  `(info)` tag, never gated. The renderer stays gated by `escape-heavy`,
  `large-table-1k` and the stream; every pack config by its deterministic byte
  row.
- **Fingerprint skip**: if the baseline's CPU model or Node *major* version
  differs from the current machine, enforcement of the **timing** benches is
  skipped with a warning — cross-machine deltas are meaningless. Byte rows
  keep gating.
- **Re-baseline** after *intentional* perf changes (and on the same machine
  the checks will run on): `node src/quick.ts --baseline`, or the full
  `pnpm bench:ssr:baseline`.
- **CI**: `.github/workflows/ci.yml`'s `bench-smoke` job runs the quick suite
  on every PR as a *correctness* gate (the micro benches' `check()` guards
  fail it), never a timing one. `.github/workflows/bench.yml` (manual
  trigger) additionally runs `bench:micro` and uploads both result files —
  shared runners are far too noisy to gate on, so CI numbers are
  informational only.

## Baseline & caveats

`results/` is gitignored except `results/baseline.json`, which
`pnpm bench:ssr:baseline` produces (string + stream + micro + quick sections
+ meta).

Re-baseline when: sigx SSR or request-path internals change intentionally, a
competitor dependency is bumped, or the benchmark scenarios/payloads
themselves change.

**Machine fingerprint caveat**: numbers are only comparable on the same
hardware/OS/Node version. `meta` records date, Node version and CPU model —
treat cross-machine comparisons (and the committed baseline on different
hardware) as indicative only.
