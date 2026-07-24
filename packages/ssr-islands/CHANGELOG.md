# Changelog

All notable changes to `@sigx/ssr-islands` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

**Removed the `./jsx` type-only entry — `client:*` types are now zero-import (#481).**

- The `import '@sigx/ssr-islands/jsx'` step was redundant: the `client:*`
  augmentation registers program-wide the moment you import
  `@sigx/ssr-islands` (server) or `@sigx/ssr-islands/client` (client), which
  every islands app already does in its entry files — the same way core's
  `use:*` directives type-check with no import. The `./jsx` subpath is gone
  (pre-1.0, no alias); delete any `import '@sigx/ssr-islands/jsx'` /
  `/// <reference types="@sigx/ssr-islands/jsx" />` — nothing replaces it.

**BREAKING — `__registerIslandChunk` is now `registerComponentChunk` (#439).**

- The lazy chunk-registration entry point (re-exported from
  `@sigx/server-renderer/client`) was renamed: the underscore island name
  misdescribed a strategy-neutral registry that the resume transform emits
  calls to as well. Hard rename, no alias (pre-1.0) — generated registry
  modules are re-emitted by the Vite transforms automatically; update any
  hand-written `__registerIslandChunk` call to `registerComponentChunk`.

**Changed: the pack rides only the public contract (#416, #439).**

- `islandsPlugin()` returns the new `SSRPack` type and registers the one
  closed-over pack object (no more internal `this` casts); the current
  component id and the boundary-table scan go through the public
  `ctx.currentComponentId()` / `ctx.boundaries()` accessors. A structural
  guard test now rejects `/internals` imports and underscore `SSRContext`
  reads in this package — the "drop-in equal of any third-party pack" claim
  is enforced, not aspirational.

**Changed: one install shape — `app.use(islandsPlugin())` (#413).**

- `install(app)` now also registers the pack's SERVER render hooks (via
  `@sigx/server-renderer`'s new `provideSSRPlugin` seam), so installing in
  the entry-server's per-request app factory is the whole install;
  `createSSR().use(islandsPlugin())` is gone (`SSRInstance.use()` was
  removed upstream).
- The client plugin-registry registration inside `install(app)` is now
  client-only (skipped when `document` is undefined) — per-request server
  apps no longer touch the module-level registry.
- Prod manifests reach the factory via `virtual:sigx-manifests`
  (`@sigx/vite`): `islandsPlugin({ manifest: islandsManifest })`.
- `IslandsManifestV2` and `IslandManifestEntry` types are now exported from
  the package root.

**The walk fallback forwards the hydration region bound.** (#373)

- Core now passes `regionEnd` — the enclosing component's trailing marker — to
  the `client.hydrateComponent` plugin hook, and the islands hook threads it
  through `scheduleComponentHydration` to `scheduleWalkedBoundary`. Without it,
  an island whose content is followed by sibling content in the same parent
  anchored on a CHILD's marker, so a structural-mismatch bail could leave part
  of the island's server-rendered content behind as a duplicate.
- `scheduleComponentHydration` takes the bound as a new optional trailing
  parameter; existing callers are unaffected.

**Islands pages now defer the sigx runtime until a strategy fires.** (#293)

- `hydrateIslands()` (from `@sigx/ssr-islands/client`) is now the whole
  client bootstrap: it self-registers the state-restoration hooks as a lazy
  plugin source, loaded together with `@sigx/server-renderer`'s hydration
  core on the first `client:*` strategy that fires. The eager surface is
  only the boundary scheduler (~2 kB, size-limit-guarded with no sigx
  ignore) — a page whose islands are all deferred executes zero framework
  JS at load. The legacy `registerClientPlugin(islandsPlugin())` +
  `hydrateIslands()` form keeps working (registration dedupes by name), but
  importing `islandsPlugin` from the package root keeps the runtime eager —
  drop it.
- Islands manifest v2 (emitted by `sigxIslands()` from `@sigx/vite`):
  `{ version: 2, islands, runtimePreload }`. `runtimePreload` names the app
  chunks exclusive to the lazy runtime graph; `islandsPlugin({ manifest })`
  accepts both v2 and the legacy flat map, and — via the new core `assets()`
  hook — emits `<link rel="modulepreload">` for them whenever a request
  records a schedulable island, so deferring execution never costs a
  first-interaction network round trip. The generated
  `virtual:sigx-islands` module now imports from `@sigx/ssr-islands/client`
  (the light entry) instead of the package root.
- **Breaking (pre-1.0):** `scheduleComponentHydration` moved off the
  `./client` entry (it feeds the hydration executor — heavy by nature); it
  remains exported from the package root. `hydrateLeftoverAsyncComponents`
  now returns `Promise<void>` (the executor loads lazily).
- Behavior note: a `client:load` island hydrates after one (preloaded)
  dynamic-import round trip instead of within the entry module's microtask
  queue.

## [0.10.0] - 2026-07-15

The runnable example app moved from in-package (`packages/ssr-islands/example/`)
to the repo's shared examples folder: `examples/ssr-islands/`. The package name
(`@sigx/ssr-islands-example`) and the `pnpm --filter` commands are unchanged.
Existing checkouts keep an empty leftover `packages/ssr-islands/example/`
folder (its ignored `node_modules/` blocks git from removing the directory) —
safe to delete. (#237)

**Island signal state is now keyed automatically — named = transferred.**
Signal state keys are derived from the declaration identifier by the
`sigxIslands()` Vite transform (`const count = ctx.signal(0)` → key
`"count"`) and injected into generated code; they are no longer component
API. Only keyed signals are captured on the server and restored on the
client — a signal without a key is plain local state, created fresh on the
client. **Breaking:** the positional `$<index>` fallback and the
unnamed-signal dev warning are removed; unkeyed signals no longer transfer.
This aligns islands with the rest of the family — state identity is explicit
or there is no transfer (`useData`'s required key, `defineStore(name)`) —
and makes any server/client asymmetry degrade to "not transferred" instead
of silently restoring wrong values. Keys are namespaced per island boundary
record, so name reuse across components (every island calling its signal
`state`) is safe; a duplicate key *within* one island keeps the first signal
and leaves later ones local-only, with a dev warning. (#235)

Rebuilt as the reference pack on the SSR boundary model (rfc-ssr-platform §1,
signalxjs/core#199, shipped in signalxjs/core#200). The plugin is now a mapping
from `client:*` directives to `SSRBoundary` records via the new pre-setup
`resolveBoundary` seam: `client:only` decomposes into `flush: 'skip'` +
`hydrate: 'load'`, captured signal state (#120) writes into the core boundary
record, and the client scheduler/registry/chunk-loader are facades over the
core boundary hydrator in `@sigx/server-renderer/client`. **`__SIGX_ISLANDS__`
is gone** — islands ride the core `window.__SIGX_BOUNDARIES__` table — and the
skip-SSR placeholder attribute is `data-boundary` (was `data-island`). New:
the `client:interaction` directive (hydrate on first
pointerdown/keydown/touchstart/focusin), and a pluggable app mode —
`app.use(islandsPlugin())` declares islands hydration (only boundary-table
entries hydrate, no root walk), so the client entry is
`defineApp(<App />).use(ssrClientPlugin).use(islandsPlugin()).hydrate('#app')`;
the standalone `hydrateIslands()` entry remains. Public API is preserved
through facades; the pack keeps zero privileged access to core.

## [0.7.0] - 2026-06-15

### Fixed

- Full-tree (walk-path) hydration no longer leaks `client:*` directive props into
  the hydrated component. The walk path now strips directives before delegating to
  core `hydrateComponent`/`render`, matching the data-driven `hydrateIsland()` path.
  (signalxjs/core#126)

### Added

- `client:only` now genuinely skips SSR. The component is no longer rendered or
  hydrated in place (it previously behaved like `client:load`); instead the
  server emits an empty `<div data-island>` placeholder — the island still
  appears in `__SIGX_ISLANDS__`, with no captured signal state — and the client
  mounts the component fresh into it. This rides a new
  `suppressComponentRender` plugin hook in `@sigx/server-renderer`. The dev
  warning about `client:only` behaving like `client:load` is removed.
  (signalxjs/core#122)
- Server-captured island *signal* state is now restored on hydration. The pack
  implements the new client `transformComponentContext` seam in
  `@sigx/server-renderer` (signalxjs/core#120) to swap `ctx.signal` for a
  restoring variant that seeds each signal from `__SIGX_ISLANDS__[id].state`
  (falling back to the literal initial), so an island resumes from its server
  value across the eager, deferred-strategy, and async-streaming hydration paths.

### Changed

- Now developed in the `signalxjs/core` monorepo and released in lockstep with
  `@sigx/server-renderer` (the standalone `signalxjs/ssr-islands` repo is
  archived). Version jumps to match the core lockstep line.
- Ported to the `@sigx/server-renderer` 0.6.x SSR API. The directive runtime
  (`getHydrationDirective`, `filterClientDirectives`, `serializeProps`) is now
  owned by this package instead of imported from `sigx/internals`.

### Removed

- Dropped the `generateSignalKey` and `SSRSignalFn` re-exports that proxied
  `@sigx/server-renderer` internals; `SSRSignalFn` is now this package's own type.
- Removed the inert `initIslandHydration` wiring hook. It existed only to await
  the core client hydration seam now delivered by signalxjs/core#120; signal-state
  restoration is wired internally and app-context propagation across deferred
  hydration imports the accessors directly from `@sigx/server-renderer/client`.

## [0.4.2] - 2026-05-10

### Changed

- First release published via GitHub Actions with npm provenance attestation. Functionally identical to `0.4.1`.

## [0.4.1] - 2026-05-10

### Added

- Initial release. Islands runtime + Vite plugin for partial hydration.
- Hydration strategies: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`.
- Streaming SSR support with async-component hydration.
