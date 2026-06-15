# Changelog

All notable changes to `@sigx/ssr-islands` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `client:only` now genuinely skips SSR. The component is no longer rendered or
  hydrated in place (it previously behaved like `client:load`); instead the
  server emits an empty `<div data-island>` placeholder — the island still
  appears in `__SIGX_ISLANDS__`, with no captured signal state — and the client
  mounts the component fresh into it. This rides a new
  `suppressComponentRender` plugin hook in `@sigx/server-renderer`. The dev
  warning about `client:only` behaving like `client:load` is removed.
  (signalxjs/core#122)

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

### Known limitations

- Client-side restoration of server-captured island *signal* state is inert
  pending a client hydration plugin seam in core (signalxjs/core#120). Selective
  hydration and `useAsync`/`useStream` state transfer are unaffected.

## [0.4.2] - 2026-05-10

### Changed

- First release published via GitHub Actions with npm provenance attestation. Functionally identical to `0.4.1`.

## [0.4.1] - 2026-05-10

### Added

- Initial release. Islands runtime + Vite plugin for partial hydration.
- Hydration strategies: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`.
- Streaming SSR support with async-component hydration.
