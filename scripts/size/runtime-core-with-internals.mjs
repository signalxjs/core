// size-limit fixture: measures @sigx/runtime-core's full contribution in one
// bundle — the public entry plus /internals, which carries createRenderer and
// the mount/patch machinery that only @sigx/runtime-dom imports. Measuring the
// public entry alone tree-shakes the renderer away, and the runtime-dom check
// externalizes it via `ignore`, so without this fixture it would be counted by
// no per-package check (only by the umbrella). Namespace re-exports keep every
// export of both entries without star-export ambiguity dropping any.
export * as publicApi from '../../packages/runtime-core/dist/index.prod.js';
export * as internals from '../../packages/runtime-core/dist/internals.prod.js';
