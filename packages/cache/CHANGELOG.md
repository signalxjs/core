# Changelog — @sigx/cache

Notable changes to `@sigx/cache`. Cross-package release notes live in the
repository-root `CHANGELOG.md`.

## [Unreleased]

Initial release (rfc-async Phase 2, signalxjs/core#195): the cache-policy
pack on core's §7 engine seam — `cachePlugin()`, per-read `cache` options
(`staleTime`, `gcTime`, `revalidateOnFocus`, `revalidateOnInterval`,
`keepPreviousData`), `invalidate()`/`mutate()` on cached reads, and
per-action `cache` effects (`invalidates` with tuple-prefix matching,
`optimistic` apply with conditional rollback). Adopts `__SIGX_ASYNC__` as
initial cache state; reads/actions without `cache` options delegate to
core's default engine verbatim.
