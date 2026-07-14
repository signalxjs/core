# Changelog

All notable changes to `@sigx/ssr-islands` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
