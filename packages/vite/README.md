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

- **Dev**: generates a `resolve.alias` entry for every installed `@sigx/*`
  package **and every one of its `exports` subpaths**, each pinned to that
  package's built entry, so the whole family resolves to one physical copy.
  Subpath entries are emitted before bare ones — Vite matches aliases by
  prefix, so a bare `@sigx/resume` ahead of `@sigx/resume/client` would rewrite
  the subpath into a nonexistent path. It also excludes **all** `@sigx/*`
  packages from `optimizeDeps` pre-bundling — the core packages plus every
  `@sigx/*` dependency found in your `package.json` (store, router, daisyui,
  …), so prebundled chunks can't carry a second reactivity copy.

  If your config already aliases a package, the plugin leaves that package
  **entirely** alone (all of its entries or none — a partially overridden set
  is worse than none, since a bare key ahead of its own subpaths breaks them).
  You should not need a hand-written map; if you do, that's a bug worth
  reporting.
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
  // Enable HMR for component() (default: true). Also drives the dev
  // full-reload for server-only pages: a zero-JS / resumable route never
  // loads its components in the browser, so an edit has no client HMR
  // boundary — the plugin reloads the page instead so the change shows.
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

### `sigxServer()` — the dev endpoint's options

The server-function plugin (`@sigx/vite/server`) serves the RPC endpoint from
`vite.middlewares` in dev, so `sigxServer()` accepts **every option
`@sigx/server`'s handler accepts** — `origin`, `maxBodyBytes`, `maxUrlBytes`,
`timeoutMs`, `onError` — and forwards them unchanged, on top of its own build
options (`include`, `exclude`, `base`, `endpoint`, `role`, `scan`,
`requireGuards`, `guard`, `renderBoundaries`). The type derives from
`ServerFnRequestOptions` rather than copying it, so an option added to the
endpoint is reachable in dev the day it ships:

```ts
sigxServer({
  maxUrlBytes: 32_000,                      // dev matches your production cap
  timeoutMs: 10_000,
  onError: (err, info) => console.error(info.name, err)
})
```

Two of them differ from their production twins by necessity: `guard` and
`renderBoundaries` are **module specifiers** here (`'/src/fn-guard.ts'`), loaded
through the SSR module runner per request so edits apply without a restart,
where a production entry passes the functions themselves.

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
import { collectAssets } from '@sigx/vite/assets';
const assets = collectAssets(manifest, ['index.html']);
```

`@sigx/vite/assets` imports **nothing** — no `node:` builtins — and its one
`process.env` read is `typeof`-guarded, so a workerd/Deno/Bun entry (where
`process` may not exist at all) can use it directly. Import it from `/assets`, not
`/ssr`: the latter also carries the dev request handler, which does import
`node:fs/promises` and `node:path`, and pulling that into an edge graph is not
possible. `@sigx/vite/ssr` still re-exports it, so existing imports keep
working.

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

The narrow sibling `virtual:sigx-manifests` exports just `islandsManifest`
and `resumeManifest`, and — unlike `virtual:sigx-app` — resolves in EVERY
mode: real inlined literals in the SSR build, `undefined` under dev (the
packs run manifest-less there). It exists for the entry-server's app
factory, the pack install site (#413):

```tsx
// src/entry-server.tsx
import { islandsManifest } from 'virtual:sigx-manifests';
export const createApp = (url) =>
    defineApp(<App />).use(islandsPlugin({ manifest: islandsManifest }));
```

### Typing the virtual modules — `@sigx/vite/client`

One reference line, next to `vite/client`, types every `virtual:*` module the
sigx plugins generate — `virtual:sigx-app`, `virtual:sigx-manifests`,
`virtual:sigx-server-fns`, `virtual:sigx-islands`, `virtual:sigx-resume/entry`:

```ts
// src/env.d.ts
/// <reference types="vite/client" />
/// <reference types="@sigx/vite/client" />
```

The two pack manifests type themselves from the packs you actually installed:
importing `@sigx/ssr-islands` gives `islandsManifest` its `IslandsManifestV2`,
importing `@sigx/resume` gives `resumeManifest` its `ResumeManifest`, and a
manifest whose pack is absent stays `unknown` — which is what the value is
anyway, since a pack that is not installed contributes no manifest. That is why
this file never imports the packs: both are optional peers, and an app with only
one of them installed still has to type-check. Registration rides the pack's own
import, exactly like the `client:*` and `use:` attribute types.

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
