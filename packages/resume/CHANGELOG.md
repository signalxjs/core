# Changelog

## [Unreleased]

### Added

- Initial package: `resumePlugin()` server half (#241). Claims
  transform-stamped components (`__resumeId`), records `hydrate: 'never'`
  boundaries (or `'interaction'` for partially-extracted components), captures
  named-signal state into boundary records, and exposes `$sigxB` on the setup
  context for the transform-injected `data-sigx-b` boundary attribute.
  Declines components used with `client:*` directives (islands owns those).
