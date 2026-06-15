# Changelog

All notable changes to `@sigx/ssr-islands` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- `client:only` currently renders + hydrates in place like `client:load`; true
  skip-SSR (never running the component server-side) needs a core
  render-suppression seam (signalxjs/core#122).

## [0.4.2] - 2026-05-10

### Changed

- First release published via GitHub Actions with npm provenance attestation. Functionally identical to `0.4.1`.

## [0.4.1] - 2026-05-10

### Added

- Initial release. Islands runtime + Vite plugin for partial hydration.
- Hydration strategies: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`.
- Streaming SSR support with async-component hydration.
