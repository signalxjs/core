# Changelog

## [Unreleased]

### Added

- `@sigx/resume/loader` — the delegation loader (~500 B brotlied), the only
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
