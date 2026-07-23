# Changelog

## [Unreleased]

### Changed

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
