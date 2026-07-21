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
    // public entry + /internals (createRenderer & co.) — see the fixture.
    name: '@sigx/runtime-core (incl. renderer internals)',
    path: 'scripts/size/runtime-core-with-internals.mjs',
    limit: '13.5 KB',
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
    limit: '13.25 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*', 'node:stream'],
  },
  {
    name: '@sigx/server-renderer/client (browser entry)',
    path: 'packages/server-renderer/dist/client/index.prod.js',
    limit: '5.5 KB',
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
    name: '@sigx/server/client (fetch stubs)',
    path: 'packages/server/dist/client/index.prod.js',
    limit: '1.9 KB',
  },
];
