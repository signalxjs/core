# Changelog

## [Unreleased]

### Added

- **Handler chunks are modulepreloaded — `ResumeManifest.handlers` does what
  it says (#410, rfc-1.0 §4.8).** `resumePlugin` now implements the pack
  `assets()` hook (the `islandsPlugin` precedent): for every boundary a
  request actually claims, the component's handler symbols (stamped by the
  transform as `__resumeQrls`) are resolved through `manifest.handlers` and
  the document's first shell flush carries `<link rel="modulepreload">` for
  each distinct handlers chunk — bytes off the critical path, execution still
  gated on the first interaction, the loader still the page's only script. A
  page with no resume boundary emits nothing; a hydrate-mode component has no
  symbols and emits nothing; a manifest-less (dev) render emits nothing; the
  component (upgrade) chunk is never warmed. Requires a client build from the
  matching `@sigx/vite` — an older transform stamps no symbols, and the hook
  then contributes nothing.

### Changed

- **The transform's contract violations are build errors (#409, rfc-1.0 §4.5)
  — breaking for a build that relied on warn-and-skip.** In `@sigx/vite/resume`:
  a duplicate component name across resume modules (was: warn, first wins),
  a component reachable only as `export default` (was: silently
  non-resumable) and a handler binding or referencing `$scope` / `$el` (was:
  downgraded to wake-on-interaction with a warning) now fail the build with a
  located message. Root `CHANGELOG.md` has the per-case before/after. The
  runtime cases stay `__DEV__` warnings (single-element root, renamed-signal
  buffered writes, wake swallowing its triggering event) and are documented
  in the README's new "The contract" section, alongside the two-place
  `refreshComponents` wiring and the rule that
  `createBoundaryRefresh({ plugins })` never sees app-level DI — pass
  `app: () => createApp()` when the app installs `serverPlugin({ types })` or
  `provideTypeHandlers` (rfc-1.0 §4.3).

## [0.15.3] - 2026-08-07

### Changed

- **`__SIGX_SERVERFN_BOUNDARIES__` is stamped non-enumerable (#634).** The
  single-flight refresh seam is pack-to-pack wiring, never emitted into a page,
  so it no longer shows up in `Object.keys(globalThis)` or devtools completion.
  Name, contract, first-stamp-wins install and `uninstall` are unchanged, and
  `@sigx/server`'s stub reads it exactly as before. `__SIGX_BOUNDARIES__` — the
  wire table this pack reads — stays enumerable on purpose. See
  `docs/seams.md`.

## [0.15.0] - 2026-08-04

### Added

- **The pack now registers its manifest type for `virtual:sigx-manifests` and
  `virtual:sigx-app` (#562).** `@sigx/vite/client` ships the ambient
  declarations for those modules but cannot type `resumeManifest` itself —
  this pack is an optional peer of it, so an app without resume must still
  type-check. It declares an empty `SigxPackManifests` registry instead, and
  this pack fills in its `resume` key, so `resumeManifest` arrives as
  `ResumeManifest | undefined` for apps that installed resume and
  `unknown | undefined` for those that did not — which is what the value is
  anyway. Registration rides importing the pack, the same zero-import
  mechanism the `$sigxB` setup-context augmentation uses.

### Fixed

- **The client install no longer disables full-tree hydration (#483).**
  `install(app)` declared `boundaries: 'explicit'` unconditionally, which
  switches `hydrate()` to the no-root-walk path: it schedules the boundary
  table and returns. Every resume record is `hydrate: 'never'`, which that
  scheduler skips, so an app calling `app.use(resumePlugin())` on the client
  hydrated **nothing** — a dead shell, no error, no warning. The mode is now
  opt-in via `resumePlugin({ boundaries: 'explicit' })`; the default leaves
  core's `'auto'` walk alone, which is what an app-rooted install wants.
  Resume's boundary isolation comes from the server-set `hydrate: 'never'`,
  not from a client hydration default.

  **Behaviour-breaking** if you relied on the implicit mode: pass the option.
  The README gains the Client section it never had — the coexist recipe
  existed only in the `plugin.ts` docstring, and described the app-less
  posture rather than coexistence.

### Changed

- **BREAKING (pre-release) — boundary refresh is data-keyed (#452).**
  `collect()` now forwards each boundary's recorded `useData` deps
  (`record.deps`) in its descriptors and skips dep-less records outright
  (they can never be admitted by the endpoint's deps ∩ `invalidates`
  gate — the `refreshes` component allowlist is removed from
  `@sigx/server`). `BoundaryRefreshRequest` gains an optional `deps`
  pass-through; the `createBoundaryRefresh` registry, trust model, and
  all `apply()` semantics are unchanged, and a refresh re-render
  re-captures deps on the fresh record automatically.

- **The pack rides only the public contract (#416, #439).** The refresh
  re-render passes `createSSRContext({ appContext })` and iterates
  `ctx.boundaries()`; component attribution uses `ctx.currentComponentId()`;
  the boundary codec (`encodeWithHandlers`/`reviveWithHandlers`) comes from
  a direct `@sigx/serialize` dependency and `reviveFromServer` from
  `@sigx/server-renderer/client` — no `sigx/internals` imports remain, and
  a structural guard test keeps it that way. `$sigxB` — the
  transform↔runtime contract — is now a typed `ComponentSetupContext`
  augmentation instead of inline casts. `resumePlugin()` returns the new
  `SSRPack` type. The generated registry modules call
  `registerComponentChunk` (renamed from `__registerIslandChunk`, see
  `@sigx/server-renderer`'s breaking note).

- **BREAKING — one install shape: `app.use(resumePlugin())` (#413).**
  `install(app)` now also registers the pack's server render hooks (via
  `@sigx/server-renderer`'s new `provideSSRPlugin` seam), so installing in
  the entry-server's per-request app factory is the whole install;
  `createSSR().use(resumePlugin())` is gone (`SSRInstance.use()` was
  removed upstream). Prod manifests reach the factory via
  `virtual:sigx-manifests` (`@sigx/vite`).
- **BREAKING** — `createBoundaryRefresh` no longer takes `ssr:`; pass
  `plugins: [resumePlugin(...)]` explicitly, or omit it and let the `app`
  option's app carry the plugin set (`app.use(resumePlugin(...))` in its
  factory). Dev warns when the resolved set contains no resume plugin.

### Added

- Single-flight boundary refresh — the client half (rfc-server §6.3, #313,
  completing the feature). `@sigx/resume/client` stamps the
  `__SIGX_SERVERFN_BOUNDARIES__` seam at module init: `collect()`
  inventories the page's refreshable boundaries for a `refreshes`-declaring
  mutation's request, and `apply()` patches the response — resumed
  boundaries get a marker-anchored DOM swap under a fresh id (records
  installed, old ids' records/scopes retired) **without their component
  chunk ever loading**; upgraded boundaries get whole-value live-signal
  writes guarded by a dispatch-order seq. Drops are silent convergence: an
  in-flight upgrade wins, buffered writes win, a focused text entry inside
  the swap range wins, and stale overlapping responses drop via retirement
  — declined/dropped boundaries catch up through `$cache` invalidation.
  Pack-internal `peekScope`/`dropScope`/`onResumeReset` support it;
  examples/resume gained the `Poll` demo and smoke assertions (fresh UI in
  one request, zero component chunks, the swapped boundary stays
  resumable).

- `createBoundaryRefresh({ ssr, components, app? })` on `@sigx/resume/server` —
  the server half of single-flight boundary refresh (rfc-server §6.3, #313):
  re-renders client boundary descriptors through the instance's plugin set in
  an id-seeded context (fresh HTML + tracking-signal state) and encodes
  `{for, id, html, state, records}` entries for the RPC envelope. Declines by
  omission (unknown registry key, lossy snapshot, re-render failure) — a
  refresh is an optimization riding a mutation that already succeeded, so
  nothing throws outward. Pairs with the endpoint's `renderBoundaries` option
  (next phase of #313).
- `resumePlugin()` stamps `refreshable: false` onto boundary records whose
  usage-site props the snapshot cannot carry (children/slots/render props) —
  the §6.3 decline signal, shipped in the table.

- `@sigx/resume/loader` — the delegation loader (~500 B brotli-compressed), the only
  script a resumable page ships: capture-phase delegation, first-event
  replay, synchronous `preventDefault`, wake dispatch for hydrate-mode
  boundaries (#241).
- `@sigx/resume/client` — QRL registry (shared in-flight resolution), scope
  resume (facade signals over serialized state), upgrade-on-write (hydrate
  with original state, replay buffered writes), `wake()` (#241).
- Initial package: `resumePlugin()` server half (#241). Claims
  transform-stamped components (`__resumeId`) and records `hydrate: 'never'`
  boundaries — the pack's delegation owns all waking (QRL replay for
  fully-extracted components, wake-on-interaction hydration for the rest);
  captures named-signal state into boundary records, names the record from
  `__resumeId`, and exposes `$sigxB` on the setup context for the
  transform-injected `data-sigx-b` boundary attribute. Declines components
  used with `client:*` directives (islands owns those).
