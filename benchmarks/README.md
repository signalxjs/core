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
pnpm bench:micro          # micro suites (server fns, codec, gate, packs, slots, reactivity)
pnpm bench:ssr:quick      # sigx-only quick suite + regression check (informational)
pnpm bench:ssr:baseline   # full run that writes/merges results/baseline.json

# Interleaved A/B between two checkouts (usually two worktrees, each built).
# Both scripts encode `--conditions production`, which is the easy thing to get
# wrong — without it the DEV dist is measured.
pnpm --filter @sigx/benchmarks run ab -- \
  --base-dir=../main --head-dir=. --rounds=5 --out=/tmp/rounds.json
pnpm --filter @sigx/benchmarks run ab:report -- --rounds-file=/tmp/rounds.json
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

`pnpm bench:micro` runs `src/run-micro.ts` over seven suites in `src/micro/`.
Payloads come from `src/fixtures/payloads.ts`, derived from the same seeded
data as the scenarios.

| Suite      | What it measures                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `codec`    | `@sigx/serialize` encode/revive over plain, rich (Date/Map/Set/BigInt/URL) and deeply nested payloads             |
| `serverfn` | `handleServerFnRequest` in process: POST read/mutation, GET idempotent read, NDJSON stream, the error path        |
| `keymatch` | the §6.3 boundary-refresh admission gate — `deps × patterns` matching, swept by size, tuple vs string patterns    |
| `refresh`  | `createBoundaryRefresh` re-rendering 1 / 8 / 32 descriptors                                                       |
| `packs`    | a scenario rendered plain vs `islandsPlugin()` vs `resumePlugin()` — time **and** payload bytes                   |
| `slots`    | `createSlots(children).default(...)` — the slot read every component with children makes, against a `slice` floor |
| `reactivity` | signal/computed/effect propagation, and the `watch(deep)` traversal, against a plain-write and a plain-walk floor |

### The reactivity suite is batch-sized (#636)

Reactivity moved here from the vitest harness, which is not baselined and which
no CI job runs — so the package underneath every other number in this repo was
the one package CI could not see move, and `watch(deep: true)` (the headline of
#546) had no bench in either harness.

Two rules govern it, both load-bearing:

- **Every `run()` performs a sized batch** — the `x1k` / `x10k` / `x100` in each
  name. mitata measures one `run()` call and `check-regression` cannot gate a
  p50 below ~0.1 ms; a signal write is tens of nanoseconds, so measuring one
  would produce a number no gate could read.
- **A bench and its `floorOf` share a batch size.** `ratioToFloor` divides two
  p50s, so pairing an x100 bench with an x10k floor reports the batch ratio and
  calls it overhead. Hence two floor families — the writes at x10k, the walks at
  x100 — and anything matching neither is an absolute timing.

`plain deep walk x100` is the floor that carries the #546 argument: the same
traversal over the **raw** fixture, no proxy and no tracking. A `watch(deep)`
bench's ratio to it is exactly what the reactive machinery adds on top of the
walk, and it is the figure that should collapse if #546 lands.

Note that the write floor is `obj.v = obj.v + 1`, not `obj.v = i`. The set trap
it floors already reads the old value before its `Object.is` test, so a
store-only floor would compare one operation against two — and a loop of stores
whose intermediate values are never read is the loop V8 is entitled to sink.
The first draft measured 1.27 ns per write, which is a floor reporting how well
it was optimised away.

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

The reactivity guards carry more weight than most, because a watcher that has
silently stopped watching and an effect graph that has come detached both cost
nothing and would report a spectacular number forever. Each one proves the graph
is live before it is measured — the fanout write runs exactly 100 effects, the
cutoff write runs none — and every `watch(deep)` bench additionally proves the
**re-track** case on a throwaway fixture: an object added in one turn and
mutated in the next must still notify. `signalxjs/actors#38` calls a miss there
silent data loss under write-behind, and it is the first thing a traversal
optimisation breaks. Both halves of that contract were verified by deliberately
weakening the probe watcher to `deep: 1` and `deep: 2` and confirming the run
fails without reporting a number.

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
  row. A *request-path* bench carries the same exemption per bench, via
  `informational: true` in its definition (`src/micro/types.ts`) — that is how
  the `slots/*` reads, all around a hundred nanoseconds, stay measured and
  guarded without ever failing a gate. The flag is read off the current run, so
  flipping it takes effect without a re-baseline.
- **Fingerprint skip**: if the baseline's CPU model or Node *major* version
  differs from the current machine, enforcement of the **timing** benches is
  skipped with a warning — cross-machine deltas are meaningless. Byte rows
  keep gating.
- **Every run reports its own coverage.** A bench with no matching entry on the
  baseline side is compared against nothing, so it cannot fail. Those rows are
  listed under the table as `ungated`, and baseline entries that were not
  measured as `stale` (a rename shows up as one of each). This is not cosmetic:
  the three `slots/*` benches added by #537 were measured, printed and ungated
  for four PRs because the mismatch was silent.
  `--require-baseline-rows` turns an ungated row into a failure — that is
  `bench:quick:ci`, which CI runs (below), and `--enforce` implies it.
- **Re-baseline** after *intentional* perf changes (and on the same machine
  the checks will run on): `node src/quick.ts --baseline`, or the full
  `pnpm bench:ssr:baseline`. Adding a quick bench means re-baselining in the
  same PR — CI fails otherwise.
- **Comparing two arbitrary result files**: `--baseline-file=<path>` and
  `--current-file=<path>` take either shape (a raw `quick-latest.json`, or a
  `baseline.json` with a `quick` section) instead of the committed baseline,
  and `--markdown=<path>` writes the comparison as a report to post.
  `--enforce` is refused alongside `--current-file`: the noise re-run can only
  re-measure `results/quick-latest.json`.

### CI

- **`ci.yml` → `bench-smoke`** runs `pnpm bench:ssr:quick:ci` on every PR. It
  is a *correctness* gate — the micro benches' `check()` guards fail it, and
  `--require-baseline-rows` fails it when a quick bench has no baseline entry
  (set membership, so it needs no matching hardware). Never a timing gate: the
  delta table prints, and "worse than +25%" notes on a CI runner are expected.
- **`bench.yml` → `bench-ab`** runs on PRs touching `packages/**`,
  `benchmarks/**` or the lockfile, and is where PR-time *numbers* come from. It
  measures two refs **on the same runner**, **interleaved** (see below), and
  posts the result as a single comment it updates in place. Absolute figures
  from a shared vCPU are worthless, but the comparison between two refs is not
  — and unlike the committed baseline it needs no machine to match. On a PR it
  never fails; read the table and decide. Fork PRs get the same table in the job
  summary (their token cannot comment).
- **`bench.yml` → `bench-ab` by hand** — dispatch it with a `base` input and it
  compares **any two refs**: `base: main`, `head: my-branch`. That is how a perf
  change gets judged *before* it is proposed, and the only place `--enforce`
  exists (the `enforce` input), for a deliberate proof run.
- **`bench.yml` → `bench-quick`** (manual dispatch with **no** `base`)
  additionally runs `bench:micro` and uploads both result files.

#### Why interleaved (#638)

Measuring base once and then head once cannot separate the change from the
machine. The head is always second, so drift, thermal state and cache warmth
land on its account. On #637 — a PR that touched no package source at all —
that read as **+3.7%, +5.9% and +6.6%** on three rows.

Raising mitata's sample budget does not help: that shrinks *within-run*
sampling error, while every sample on one side shares the same position in
time. So the rounds alternate, and the alternation is **counterbalanced** —
even rounds base-first, odd rounds head-first — so a linear drift carries
equal and opposite bias in the two orders and cancels in the paired deltas.

A row is only called `improved`/`regressed` when **every round agrees in sign**
(a sign test at p = 2⁻ᴿ, ~3% at the default R=5) **and** the median delta clears
both 3% and the row's own run-to-run spread. A side whose spread exceeds 10%
is reported `noisy` and claims nothing.

That second condition is not decoration. In a local null run — the *same*
checkout on both sides, so a known-zero effect — `serverfn/POST noop` came out
at a median of **−15.1% with every round negative**, and the 200-row deep-watch
bench at **−37.7%**. Unanimity alone would have called both an improvement; the
spread rule refused them. Zero rows were called in that run, which is the
calibration the design has to pass.

`ab.ts` (the round driver) is deliberately free of local imports and npm
dependencies, so `signalxjs/actors` — which carries its own copy of `bench.yml`
and a differently-shaped quick suite — can take it unchanged.

### When the baseline goes slack

The gate is one-sided (`deltaPct > threshold`), so an improvement never fails a
run — and, until #647, never said anything either. A row that got 4x faster
printed `-75.0%` with status `ok` and kept being measured against the old, slow
number: after #642 the committed baseline claimed 71.15 ms for a row running at
25.50 ms, so it would have kept passing until it regressed past **+179%**.

`check-regression` now reports any gated timing row that is faster than its
baseline by more than the threshold, in the console and in the markdown report:

```
stale baseline — 1 row(s) are more than 25% FASTER than the recorded baseline,
so they now gate nothing until it is re-recorded:
  - reactivity/watch(deep) 1 mutation, 200-row state x100: 25.4971 -> 6.4257 (-74.8%)
```

It is a note, never a failure — failing a run for making something faster would
be hostile, and `bench-nightly` is where it most needs to be seen, since that is
the job comparing against the committed baseline every night. It is skipped when
`--baseline-file` is passed: the A/B compares two refs, where "before" is a
measurement rather than an anchor and outrunning it is the point.

**So: re-baseline after a large win, not only after adding a bench.**

## Baseline & caveats

`results/` is gitignored except `results/baseline.json`, which
`pnpm bench:ssr:baseline` produces (string + stream + micro + quick sections
+ meta).

**The committed baseline belongs to the bench VM.** It is recorded on the
dedicated self-hosted runner (`AMD EPYC 9V74`, Node 24), which is also the
machine `bench-nightly.yml` enforces on. That pairing is the whole point: the
fingerprint check below means a baseline recorded anywhere else silently
disables timing enforcement while still printing a full delta table — which is
exactly how it came to be disabled for months.

So **do not commit a locally-recorded baseline.** Re-baseline with the
**Bench re-baseline** workflow (`workflow_dispatch` → `bench-baseline.yml`),
which records on the VM and opens a PR against your branch. Running
`pnpm bench:ssr:baseline` locally is still useful for your own before/after
comparisons; just don't commit the result.

Re-baseline when: sigx SSR or request-path internals change intentionally, a
competitor dependency is bumped, or the benchmark scenarios/payloads
themselves change.

**Machine fingerprint caveat**: numbers are only comparable on the same
hardware/OS/Node version. `meta` records date, Node version and CPU model —
treat cross-machine comparisons (and the committed baseline on different
hardware) as indicative only.

This cuts both ways: a machine also stops being comparable to *itself*. A
baseline recorded under load bakes in slow numbers and hides real regressions,
and a machine that has since changed behaviour reads every row as a regression
it is not. Before re-baselining, confirm the machine is quiet — run the suite
twice and check that the rows your change does not touch land within a few
percent of the existing baseline. If they don't, don't record; the `bench-ab`
job compares base against head on one runner and needs no baseline at all.
(`bench-baseline.yml` automates the quiet check: it refuses to record if the
VM's 1-minute load average is above 0.8.)

**What the VM does and does not fix.** Three back-to-back quick runs on it:

| Row | spread |
|---|---|
| `large-table-1k` | 0.45 % |
| `keymatch/gate 32x32 deps` | 0.58 % |
| `serverfn/POST read 1k rows` | 1.1 % |
| `escape-heavy` | 1.3 % |
| `codec/parse+revive` | 1.7 % |
| `refresh/boundary refresh x32` | 1.7 % |
| `packs/large-table-1k resume` | 1.9 % |
| `codec/encode+stringify` | 4.1 % |
| every `(bytes)` row | bit-identical |

Every timing row above ~0.1 ms lands in 0.45–4.1 %, against the ±5 % floor
`bench-ab` saw on a shared runner. But `small-page` still swings 50 %
(0.012–0.018 ms, its sample count jumping 12 → 19971 between runs), and stream
TTFB 35 %. That is **timer resolution, not machine noise** — no box fixes it.
Those rows need a bigger unit of work, and until they get one they belong in
`INFORMATIONAL_TIMINGS`, where they already are.

`DEFAULT_THRESHOLD_PCT` stays at 25 for now. The measured floor suggests ~10 is
defensible, but that number should come from a few weeks of real runs on the
box rather than from one afternoon's measurements.
