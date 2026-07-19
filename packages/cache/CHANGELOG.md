# Changelog — @sigx/cache

Notable changes to `@sigx/cache`. Cross-package release notes live in the
repository-root `CHANGELOG.md`.

## [Unreleased]

### Added

- Server-declared invalidation (rfc-server §6.2, core#311): `cachePlugin()`
  now installs the `__SIGX_SERVERFN_CACHE__` envelope seam — when a
  `serverFn` response carries `$cache.invalidates`, each pattern feeds
  `store.invalidate()` directly (tuple prefixes included). No wiring, no
  dependency on `@sigx/server` (a global seam, not an import); disposal
  removes only the app's own handler.

### Changed

- Production builds now log a compact coded error when the focus-revalidation
  trigger throws while subscribing — `SIGX700 — see https://sigx.dev/errors/SIGX700/`
  instead of the full message, which is kept dev-only (`__DEV__`-stripped from the
  prod dist). Extends the runtime-core prod-error-code pattern (core#230) to this
  pack. (#289)

## [0.10.0] - 2026-07-15

Renderer portability (signalxjs/core#205): the pack now depends on
`@sigx/runtime-core` + `@sigx/reactivity` instead of the `sigx` umbrella
(no DOM renderer in its module graph), gates fetch-on-mount on core's
live-client signal instead of `typeof window` (windowless client runtimes
work once their platform declares via `declareLiveClient()`), and the
focus-revalidation event source is pluggable — `cachePlugin({
revalidateTrigger })` with the DOM focus/visibility listener as the web
default. The module augmentation moved to `@sigx/runtime-core` (reaches
`sigx` consumers unchanged through its re-export).

Initial release (rfc-async Phase 2, signalxjs/core#195): the cache-policy
pack on core's §7 engine seam — `cachePlugin()`, per-read `cache` options
(`staleTime`, `gcTime`, `revalidateOnFocus`, `revalidateOnInterval`,
`keepPreviousData`), `invalidate()`/`mutate()` on cached reads, and
per-action `cache` effects (`invalidates` with tuple-prefix matching,
`optimistic` apply with conditional rollback). Adopts `__SIGX_ASYNC__` as
initial cache state; reads/actions without `cache` options delegate to
core's default engine verbatim.
