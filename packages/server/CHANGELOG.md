# Changelog

## [Unreleased]

### Added

- Native-client transport (rfc-server rev 2, #318/#320): `configureServerFn({
  endpoint, headers, fetch })` in `@sigx/server/client` — stubs resolve the
  transport at call time (absolute endpoints, static or async header
  factories, injected fetch; `content-type` merges last and is not
  overridable). Zero config is byte-identical to v1.
- `origin: 'verify-when-present'` on the request handlers: verifies the
  `Origin` header when present, admits header-less programmatic clients
  (native apps, CLIs); `Origin: null` is a present header and still
  rejected. Default stays `'same-origin'`.
- Live-client guard (rfc-server rev 2 N.2): the real `serverFn` wrapper
  throws when invoked in a declared live client
  (`globalThis.__SIGX_LIVE_CLIENT__`, stamped by `@sigx/runtime-core`'s
  `declareLiveClient()`) — a lynx/terminal build that skipped the stub swap
  fails loudly instead of running server bodies locally.
- Stable routes (rfc-server rev 2 N.3, #320): the endpoint resolves hash-free
  stable symbols (`<stableId>#<name>`) alongside hashed ones — the guard's
  `info.name` derives from the after-`#` segment first, so a stable id with a
  hashed-looking tail can't misparse. The options form accepts `id?: string`
  (read statically by the build; a runtime no-op) to pin published routes
  across file moves.

- Inline server functions (rfc-server §1.1(b), #305): a module-scope
  `const x = serverFn(...)` in any component file is extracted in place —
  the client build gets the fetch stub and strips imports orphaned by the
  swap; the SSR build keeps the body (one module instance) and gains a
  mangled export the endpoint resolves. The imports-only capture rule is
  a hard build error (module scope, component scope, JSX all rejected),
  never a degrade.

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
