#!/usr/bin/env bash
# The Velt POC end to end: renders the benchmark scenarios with sigx on Node and with the sigx
# provider on Velt (generic and precompile lowering), checks that the HTML is byte-identical,
# and prints a timing table. Prerequisites: `pnpm install && pnpm build` at the repository root,
# and `velt` (with clang 16+ for --release builds) on PATH. Usage: ./run.sh [iterations]
set -euo pipefail
cd "$(dirname "$0")"
iterations="${1:-20}"
rm -rf out && mkdir -p out/build-precompile

echo "== velt test"
velt test

echo "== build (velt --release)"
velt build app/main.vlt --release -o out/sigx-velt
# The precompile variant: the same app with the import source switched.
for f in data main scenarios; do
  sed -e 's#^// @jsxImportSource ../sigx$#// @jsxImportSource ../../sigx/precompile#' \
      -e 's#"../sigx/index"#"../../sigx/index"#' app/$f.vlt > out/build-precompile/$f.vlt
done
velt build out/build-precompile/main.vlt --release -o out/sigx-velt-precompile

echo "== render"
node --conditions production node/reference.ts "$iterations" | tee out/results.jsonl
out/sigx-velt "$iterations" out/velt | tee -a out/results.jsonl
out/sigx-velt-precompile "$iterations" out/velt-precompile | tee -a out/results.jsonl

echo "== byte-identical to sigx on Node?"
status=0
for dir in velt velt-precompile; do
  for f in out/node/*.html; do
    s="$(basename "$f")"
    if cmp -s "$f" "out/$dir/$s"; then echo "ok   $dir/$s"; else echo "DIFF $dir/$s"; status=1; fi
  done
done

node node/report.ts out/results.jsonl
exit $status
