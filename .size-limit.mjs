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
    limit: '13 KB',
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
      (config.external ??= []).push('./hydrate-core-*');
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
    name: '@sigx/ssr-islands/client (browser entry)',
    path: 'packages/ssr-islands/dist/client/index.prod.js',
    limit: '1 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
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
];
