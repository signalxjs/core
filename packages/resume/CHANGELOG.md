# Changelog

## [Unreleased]

### Added

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
