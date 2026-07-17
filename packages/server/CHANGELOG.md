# Changelog

## [Unreleased]

### Added

- Initial package (rfc-server v1, #302/#305): `serverFn()` — server
  functions authored in `*.server.ts` modules, extracted to typed fetch
  stubs by `@sigx/vite/server`. Direct form (`serverFn(async (rq, ...args) =>
  …)`) and options form (`{ input, use, handler }`) with a Standard Schema
  validator that always runs server-side and a per-function guard chain no
  transport can skip. `ServerFnError` / `isServerFnError` as the branded
  error channel.
- `@sigx/server/server` — `handleServerFnRequest()`, the WinterCG endpoint
  (`POST {base}/{symbol}`, `{"args"}` / `{"data"}` envelope) with the
  security defaults as first-class behavior: POST-only + JSON media type +
  same-origin Origin check, unconditional `guard` hook, `maxBodyBytes`
  enforced during read, prototype-pollution-safe parsing, prod error
  masking, structured 404 for version skew.
- `@sigx/server/node` — `createServerFnHandler()`, the connect-style
  adapter (sibling of `createRequestHandler`).
- `@sigx/server/client` — `__serverFnStub` / `__serverOnly`, the
  dependency-free stub runtime the transform emits imports of.
