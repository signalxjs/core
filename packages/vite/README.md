# @sigx/vite

Vite plugin for [SignalX](https://sigx.dev/core/) — wires up dev-mode source
aliasing, HMR for `component()`, and ships a small `sigx-types` CLI that
generates TypeScript definitions for tag-named components.

📚 **Full guides, API reference and live examples → <https://sigx.dev/vite/>**

## Install

```bash
npm install -D @sigx/vite
```

`@sigx/vite` peer-depends on `vite >= 8` and `sigx`.

## Usage

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';

export default defineConfig({
  plugins: [sigx()],
});
```

That's it — the plugin handles the rest. Its job is keeping `@sigx/reactivity`
a **single module instance** in every environment (two instances mean signals
written through one never trigger effects tracked by the other — silently
dead UI):

- **Dev**: aliases the core `@sigx/*` packages to source, and excludes **all**
  `@sigx/*` packages from `optimizeDeps` pre-bundling — the core packages plus
  every `@sigx/*` dependency found in your `package.json` (store, router,
  daisyui, …), so prebundled chunks can't carry a second reactivity copy.
- **SSR**: sets `ssr.noExternal: ['sigx', /^@sigx\//]` so the whole family
  stays in the SSR module graph instead of splitting between Vite's module
  runner and Node's resolver.
- **Build**: dedupes the core packages and pins the runtime into one shared
  `sigx` chunk.

Your own `optimizeDeps.exclude` / `ssr.noExternal` entries are merged with the
plugin's, never replaced.

## Options

```ts
sigx({
  // Enable HMR for component() (default: true)
  hmr: true,

  // Port for Vite's HMR websocket. Only relevant in middleware mode (the
  // standard SSR setup), where Vite's fixed default (24678) collides when
  // two dev servers run on one machine. Unset: the plugin picks a free port
  // automatically. Explicit `server.hmr` settings in your Vite config always
  // take precedence.
  hmrPort: undefined,

  // SSR mode: ONE `vite build --app` produces the client bundle (with its
  // asset manifest) into dist/client AND the server entry into dist/server —
  // shaped by `adapter` (default nodeAdapter(): dependencies external, one
  // module graph with the production request handler; see "Deployment
  // artifacts" below).
  ssr: { entry: 'src/entry-server.tsx' },
})
```

## SSR mode

The dev server is `createServer` plus one handler; production is static
assets plus one handler (`@sigx/server-renderer/node`). The entry contract:
export `createApp(url)` returning a fresh per-request app
(`docs/router-ssr-contract.md`).

```ts
// dev
import { createDevRequestHandler } from '@sigx/vite/ssr';
app.use(vite.middlewares);
app.use(await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' }));

// prod: resolve manifest entries into DocumentOptions.assets
import { collectAssets } from '@sigx/vite/ssr';
const assets = collectAssets(manifest, ['index.html']);
```

### Styles in dev

There is no manifest in dev, and Vite serves JS-imported CSS
(`import './styles.css'`) as a *module* that injects a `<style>` at runtime —
so a server-rendered document would carry no styles in its head and paint
unstyled until the client entry executes.

`createDevRequestHandler` closes that gap: it walks the SSR module graph and
inlines the reachable CSS into `<head>` as `<style data-vite-dev-id="…">`,
the shape Vite's client adopts on boot and rewrites in place on HMR — so
there is no flash, no duplicated rules, and CSS HMR is unaffected. Nothing to
configure; production is untouched (the built template carries real `<link>`
tags).

Pass `devStyles: false` to opt out if your template already ships its own
stylesheet link.

## Deployment artifacts — `ssr.adapter` and `virtual:sigx-app`

The build seam of the deployment RFC (`docs/rfc-deploy.md` §3). `ssr.adapter`
is a plain `SigxAdapter` object — default `nodeAdapter()`, which keeps
today's externalized Node output byte-identical:

```ts
sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: nodeAdapter() } })
```

`serverBuild: 'external'` resolves deps from node_modules at runtime (Node /
Bun hosts); `serverBuild: 'bundled'` produces a fully self-contained server
build (`resolve.noExternal: true`, platform `conditions` — a REPLACEMENT
array, so `node` is present only if the adapter lists it — target `esnext`,
`runtimeExternal` for platform-scheme imports). Binary on purpose:
partially-external is the dangerous middle ground for DI-token identity.
Build ordering is explicit: client → ssr → remaining environments →
`adapter.generate(ctx)` (which sees both finished output trees). Adapters
may also hook the dev server via `dev(server)` — dev stays
`createDevRequestHandler` on every platform.

The document-side artifacts become code: `virtual:sigx-app` exports
`template`, `assets` (precomputed `collectAssets`), `manifest`,
`islandsManifest`, and `resumeManifest` as inlined literals — no filesystem
in the output. External builds also materialize it as
`dist/server/sigx-app.js` (imports of the virtual resolve to that emitted
sibling), so a Node `server.mjs` collapses from four `readFile`s to one
import:

```js
const { template, assets, islandsManifest, resumeManifest } = await import(
    new URL('./dist/server/sigx-app.js', import.meta.url).href
);
```

Bundled builds inline the module instead — one self-contained file is the
deliverable. In dev the virtual throws (dev has no manifests;
`createDevRequestHandler` resolves template/assets live). Combining
`ssr.adapter` with `sigxServer({ role: 'client' })` is a config-time error —
a client-role build has no server for an adapter to shape.

## Islands

`sigxIslands()` (from `@sigx/vite/islands`) completes the
`@sigx/ssr-islands` story: island modules (`*.island.tsx` or anything under
`islands/`) get stable `__islandId` identities and automatic signal state
keys (`const state = ctx.signal(…)` is keyed `"state"` from the declaration —
named = transferred, per island instance), `virtual:sigx-islands`
registers a lazy code-split loader per island in the client entry, and the
client build emits `.vite/sigx-islands-manifest.json` for
`islandsPlugin({ manifest })` on the server.

## 📚 Documentation

Plugin options, HMR, the `sigx-types` CLI, TSX setup and subpath exports —
full guides, the complete reference and live examples → **<https://sigx.dev/vite/>**
