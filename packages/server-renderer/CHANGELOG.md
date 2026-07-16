# Changelog

All notable changes to `@sigx/server-renderer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

**The boundary scheduler split from the hydration executor — deferred pages
now execute zero runtime JS at load.** (#293)

- New `@sigx/server-renderer/client/scheduler` entry: the eager half of
  selective hydration (strategy scheduling, boundary-table access, marker
  index, the `sigx:async-ready` listener). It value-imports nothing from the
  sigx family — a page whose boundaries are all `idle`/`visible`/`media`/
  `interaction` pays ~2 kB at load instead of executing the renderer. The
  executor (`hydrateComponent`, `render`, in-place/skip-mount) lives in a
  separate dist chunk loaded by `loadHydrationCore()` on the first strategy
  that fires (cached; a failed load retries on the next trigger). The
  `./client` barrel re-exports everything unchanged.
- `registerClientPlugin` now also accepts a **lazy plugin source**
  `{ name, load }` — the plugin module is imported together with the
  hydration core, so a pack's client hooks can live in the same
  lazily-fetched chunk as the renderer. Registrations dedupe by `name`
  (first-wins). New `resolveClientPlugins()` / `hasPendingClientPlugins()`
  accompany it; boundary-scheduled hydration paths resolve lazy sources
  before the first `hydrateComponent`, so synchronous client hooks always
  see resolved plugins.
- New optional server plugin hook `assets(ctx)`: contribute
  `{ modulepreload }` URLs to the document shell, deduped against caller
  assets and core's per-boundary chunk preloads. This is the pack-owned side
  of the preload policy — a pack whose runtime loads lazily keeps the fetch
  off the critical path without core knowing what the chunk is.
- Behavior note: a `hydrate: 'load'` boundary now hydrates after one
  dynamic-import round trip (pair with an `assets()` preload to keep the
  chunk warm) instead of within the entry module's microtask queue.
