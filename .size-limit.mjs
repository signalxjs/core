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
    limit: '12.5 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*', 'node:stream'],
  },
  {
    name: '@sigx/server-renderer/client (browser entry)',
    path: 'packages/server-renderer/dist/client/index.prod.js',
    limit: '5 KB',
    ignore: ['sigx', 'sigx/*', '@sigx/*'],
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
];
