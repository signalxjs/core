# Changelog

## [Unreleased]

### Added

- Initial package: `resumePlugin()` server half (#241). Claims
  transform-stamped components (`__resumeId`) and records `hydrate: 'never'`
  boundaries — the pack's delegation owns all waking (QRL replay for
  fully-extracted components, wake-on-interaction hydration for the rest);
  captures named-signal state into boundary records, names the record from
  `__resumeId`, and exposes `$sigxB` on the setup context for the
  transform-injected `data-sigx-b` boundary attribute. Declines components
  used with `client:*` directives (islands owns those).
