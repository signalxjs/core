// size-limit resolves bare imports with esbuild, which honors tsconfig `paths`
// and applies no `production` export condition — left alone, the umbrella
// check would bundle the dev dists via packages/sigx/tsconfig.json's
// `@sigx/*` → `../*/dist` mappings. This override pins resolution to the
// prod dists through each package's exports map. (Checks whose `@sigx/*`
// imports are `ignore`d never resolve them, so only the umbrella needs it.)
function resolveProdDists(config) {
  // Custom `conditions` keep esbuild's import/require/default but drop the
  // implicit `module` condition — list it explicitly so dual-format deps
  // that rely on it keep resolving.
  config.conditions = ['production', 'module'];
  config.tsconfigRaw = '{}';
  return config;
}

export default [
  {
    name: 'sigx (full framework)',
    path: 'packages/sigx/dist/sigx.prod.js',
    limit: '20 KB',
    modifyEsbuildConfig: resolveProdDists,
  },
  {
    name: '@sigx/reactivity',
    path: 'packages/reactivity/dist/index.prod.js',
    limit: '5 KB',
  },
  {
    // The boundary codec. NO ignore list, and none is possible — the package
    // has zero dependencies by design: `@sigx/server/client` imports it, and
    // that entry is itself the "stubs import nothing" guard. Anything added
    // here lands in a size-limited entry resume handler chunks replicate.
    name: '@sigx/serialize',
    path: 'packages/serialize/dist/index.prod.js',
    limit: '1 KB',
  },
  {
    // Opt-in binary vocabulary (#569). Its own entry pins the handler's size
    // AND — because the root entry above is untouched — proves that NOT
    // opting in still costs zero. No ignore list; the module is
    // runtime-self-contained (type-only import of the root).
    name: '@sigx/serialize/bytes (opt-in binary handler)',
    path: 'packages/serialize/dist/bytes.prod.js',
    limit: '1 KB',
  },
  {
    // The single-walk JSON emitter (#657), opt-in for the same reason /bytes
    // is: the root above sits at 916 B of its 1 KB with no ignore list
    // possible, so a second encoder cannot ride it — and the untouched root
    // row is the proof that NOT importing this still costs zero. Server-side
    // callers only (@sigx/server-renderer's blob emitters, storage adapters).
    // Measures the walk PLUS the vocabulary chunk it shares with the root
    // (BUILTIN_TYPE_HANDLERS / $esc / MAX_DEPTH, defined once in
    // src/shared.ts), so it reads higher than the walk alone. No ignore list;
    // the package has no dependencies to ignore.
    name: '@sigx/serialize/stringify (single-walk JSON emitter)',
    path: 'packages/serialize/dist/stringify.prod.js',
    // 1.11 KB measured, of which ~175 B is the pure-JSON fast path (the scan
    // that hands a node of plain scalars to the native serializer). It earns
    // that: without it the fused walk LOSES ~10% to encode+stringify on a
    // payload with no codec hits, because it replaces a C++ emitter with a JS
    // one. Extracting the vocabulary into src/shared.ts left the root row at
    // 909 B (from 916 B), so the split itself cost nothing.
    // 1.11 → 1.43 KB with #666: the fast path fires per RUN, not just per
    // node — consecutive eligible array elements (scalar-valued rows, rows
    // whose only codec hits are built-in scalar-payload leaves like a Date
    // field) go to the native serializer as ONE batch. Per-node calls made a
    // 500-row collection measurably WORSE than the two-walk pair it replaced;
    // batching is the difference between winning on one big node and winning
    // on many small ones. The root row above stays at 909 B — the batching
    // code lives entirely in this entry's chunk.
    limit: '1.5 KB',
  },
  {
    // public entry + /internals (createRenderer & co.) — see the fixture.
    name: '@sigx/runtime-core (incl. renderer internals)',
    path: 'scripts/size/runtime-core-with-internals.mjs',
    // 13.5 → 14.25 KB with #525: `mergeProps` (the one part of prop
    // forwarding a compiler-flattened JSX spread cannot do — class concat,
    // style merge, handler chaining with case normalization, ref chaining)
    // plus `parseStringStyle`, moved here from the SSR serializer so both
    // sides share one parser. The fixture namespace-re-exports both entries,
    // so none of it tree-shakes; sat at 14.26 KB, of which ~0.1 KB is the
    // two-pass key bucketing that keeps a handler-shaped key out of both the
    // handler group and the plain map (returning it twice from `ownKeys`
    // throws on any spread). @sigx/server-renderer drops 13.67 → 13.51 KB for
    // the same move.
    limit: '14.3 KB',
    // Not redundant: the fixture's imports are relative, but the dist files
    // themselves import @sigx/reactivity as bare specifiers.
    ignore: ['@sigx/*'],
  },
  {
    name: '@sigx/runtime-dom',
    path: 'packages/runtime-dom/dist/index.prod.js',
    limit: '4 KB',
    ignore: ['@sigx/*'],
  },
  {
    name: '@sigx/server-renderer',
    path: 'packages/server-renderer/dist/index.prod.js',
    // 13 → 13.25 KB when createFetchHandler landed on the root entry
    // (rfc-deploy §2, Phase 1 — the RFC budgets its bytes here).
    // 13.25 → 13.35 KB with #413: the app-carried plugin seam
    // (provideSSRPlugin/getSSRPlugins + per-render merge) — the one-install-
    // shape refactor's bytes; sat at 13.28 KB after trims.
    // 13.35 → 13.4 KB with #416: the typed pack contract's two context
    // accessors (currentComponentId/boundaries) + the appContext option;
    // sat at 13.36 KB.
    // 13.4 → 13.5 KB with #452: §6.3 automatic boundary dep capture
    // (recordBoundaryDep — the nearest-boundary parent-chain fold in
    // serverUseAsync); sat at 13.44 KB.
    // 13.5 → 13.6 KB with #478: hydrated component vnodes now always get a
    // trailing anchor (synthesized when the SSR marker is unreachable, as it
    // is inside a streamed placeholder wrapper) and the streamed-boundary
    // flow adopts the walk's live vnode; sat at 13.56 KB after trims.
    // 13.7 → 13.75 KB with #571 (v3 phase 5): keepAlive/onSettled — the
    // fetch handler's until-promise + chunksToBytes' body-settle latch, so
    // request-value disposal waits for the streamed body, not the shell.
    // 13.6 → 13.7 KB with #492: the wrapper-ownership test (only the
    // component the placeholder is named after may descend into it) plus the
    // streamed-boundary liveness guard; sat at 13.62 KB.
    limit: '13.75 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*', 'node:stream'],
  },
  {
    name: '@sigx/server-renderer/client (browser entry)',
    path: 'packages/server-renderer/dist/client/index.prod.js',
    // 5.5 → 5.65 KB with #413: the entry gained the app-carried plugin seam
    // (the token + provide/get pair packs call from install(app)); sat at
    // 5.57 KB. The eager-page cost lives on the scheduler entry, which is
    // untouched (2.6 KB).
    // 5.65 → 5.75 KB with #478: the same anchor/live-vnode fix as the root
    // entry above — these are its client-side bytes; sat at 5.71 KB. The
    // scheduler entry is still untouched (2.61 KB).
    // 5.75 → 5.8 KB with #523: the hydration path carries the peeled `ref`
    // through to the setup context, mirroring the client mount path so the
    // two cannot disagree on what props a component sees; sat at 5.76 KB.
    limit: '5.8 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
  },
  {
    // The eager half of selective hydration — what a page pays at load when
    // every island strategy is deferred. NO sigx ignore — this entry doubles
    // as the "scheduler imports no runtime" guard: if the scheduler ever
    // regains a static sigx-family import, esbuild bundles the runtime and
    // the check blows past the limit. Only the lazily-imported executor
    // chunk is marked external (hashed dist name, hence the wildcard).
    name: '@sigx/server-renderer/client/scheduler (eager scheduler)',
    path: 'packages/server-renderer/dist/client/scheduler.prod.js',
    limit: '3 KB',
    modifyEsbuildConfig(config) {
      // Externalize ONLY the lazily-imported executor chunk. Its hashed
      // name is rolldown's chunk-naming heuristic — currently
      // `hydrate-core-<hash>` (largest module in the chunk); the
      // `hydration-core-*` variant is listed in case the heuristic drifts
      // to the imported module's own name. Deliberately NOT a broad
      // wildcard: esbuild would match the facade's static
      // `../scheduler-<hash>.prod.js` import too, externalizing the very
      // code this entry measures (observed: 2.13 kB → 226 B). If BOTH
      // names miss after a tooling change, the check fails loudly upward
      // (executor + runtime get bundled), never silently under — and the
      // source-level closure walk in dependency-direction.test.ts guards
      // the split structurally either way.
      (config.external ??= []).push('./hydrate-core-*', './hydration-core-*');
      return config;
    },
  },
  {
    name: '@sigx/ssr-islands',
    path: 'packages/ssr-islands/dist/index.prod.js',
    limit: '2 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*', 'node:stream'],
  },
  {
    name: '@sigx/cache',
    path: 'packages/cache/dist/index.prod.js',
    limit: '3 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
  },
  {
    // The islands package's EAGER surface — what a page pays at load before
    // any island strategy fires. NO sigx ignore: like the scheduler entry
    // above, this doubles as the "no runtime on the eager path" guard; it
    // bundles @sigx/server-renderer's scheduler through the prod dists, so
    // only the lazily-imported executor chunk is external.
    name: '@sigx/ssr-islands/client (eager islands entry)',
    path: 'packages/ssr-islands/dist/client/index.prod.js',
    limit: '3.5 KB',
    modifyEsbuildConfig(config) {
      resolveProdDists(config);
      (config.external ??= []).push('./hydrate-core-*', './hydration-core-*', './plugin-hooks-*');
      return config;
    },
  },
  {
    // The page's only initial script on a resumable page. NO ignore list —
    // this entry doubles as the "loader imports nothing" guard.
    name: '@sigx/resume/loader (delegation loader)',
    path: 'packages/resume/dist/loader/index.prod.js',
    limit: '1.5 KB',
  },
  {
    name: '@sigx/resume/client (browser entry)',
    path: 'packages/resume/dist/client/index.prod.js',
    limit: '3 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
  },
  {
    // The fetch stubs the server-fn transform emits imports of. NO ignore
    // list — this entry doubles as the "stubs drag no runtime" guard (resume
    // handler chunks replicate stub imports, and a zero-JS page must not pull
    // the framework to make one RPC call). The absent ignore list is what
    // makes that real: esbuild follows every import, so anything the stub
    // reaches is counted here.
    // 1 KB → 1.25 KB with #311: the entry absorbed the rev-2 transport
    // config (#329), the stream stub (#340), and $cache delivery (#311) —
    // all semantics, no dependencies (the ceiling #320 pre-approved).
    // 1.25 KB → 1.9 KB with #364: the rfc-server §4 wire codec (encode +
    // revive, seven built-in tags, both directions). It is IMPORTED from
    // @sigx/serialize, not inlined — that package is dependency-free for
    // exactly this reason, and the bytes land in this measurement either way.
    // Sits at 1.81 KB. An inlined copy measured 1.73 KB: sharing costs ~80 B
    // because the module boundary blocks some inlining, and that is the
    // deliberate trade — one implementation instead of two that drift (the
    // duplicated pair had already grown the same $esc bug twice).
    // 1.9 KB → 2 KB with #354: the GET branch for cache-marked reads
    // (query-string args + the dev URL-length warning) landed the entry at
    // 1.89 KB — 10 B of headroom is a CI hair-trigger, not a budget.
    // 2 KB → 2.1 KB with #313: the §6.3 boundary-refresh sidecar
    // (collect/apply through the __SIGX_SERVERFN_BOUNDARIES__ seam + the
    // body merge + dispatch seq) landed at 2.01 KB — pure seam calls, no
    // dependencies; the patch logic itself lives in @sigx/resume/client.
    // 2.1 KB → 2.4 KB with #355: percent-free request URLs. Two additions,
    // both semantics: per-segment path encoding (+36 B — a stable symbol's
    // slashes are real separators now, which is what retires the `%2F`
    // proxy/CDN hazard), and the GET read's named-argument query
    // (+180 B — `?a0=shoes` instead of `?args=%5B%22shoes%22%5D`, with the
    // scalar grammar that keeps types intact). The entry was sitting at
    // EXACTLY 2.1 KB beforehand, so this bump covers the change plus the
    // headroom that was already gone. The decode half deliberately lives in
    // its own module (`fn-url-decode`) so the stubs never bundle it.
    name: '@sigx/server/client (fetch stubs)',
    path: 'packages/server/dist/client/index.prod.js',
    // 2.4 → 2.45 KB with #559: the stubs bundle both codec halves, and the
    // depth guards (encode AND revive refuse >256 levels — stack safety on
    // attacker-typable wire data) plus the shared-subtree encode memo are
    // ~10 B of real semantics, plus a little headroom.
    limit: '2.45 KB',
  },
  {
    // The app-plugin face (#413): serverPlugin (transport + one-registration
    // types, #411). Imports the sigx runtime (bare, ignored) and the stub
    // entry (relative chunk, externalized — it has its own entry above);
    // this measures only the plugin's own glue.
    name: '@sigx/server/plugin (app-plugin face)',
    path: 'packages/server/dist/plugin.prod.js',
    limit: '1 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
    modifyEsbuildConfig(config) {
      (config.external ??= []).push('./client/*', './client-*');
      return config;
    },
  },
];
