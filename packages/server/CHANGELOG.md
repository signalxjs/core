# Changelog

## [Unreleased]

### Changed

- **BREAKING (pre-1.0)**: `ServerFnContext.signal` renamed to
  **`abortSignal`** — in a signals framework, `signal` must always mean a
  reactive signal; `rq.signal` beside `ctx.signal(...)` invited confusion.
  The platform-named twin remains available as `rq.request.signal`. (#326)

### Added

- Server-declared cache directives (rfc-server §6.2, #311): the options
  form gains `invalidates(input, result)` — computed after the handler on
  the VALIDATED input, attached to the envelope as `$cache.invalidates`,
  and delivered by the fn stub to the `__SIGX_SERVERFN_CACHE__` global seam
  (stamped by `@sigx/cache`'s plugin — no import in either direction, the
  live-client-marker pattern). Wire-only: in-process calls skip it. A
  throwing seam never breaks the RPC result.
- `serverStream()` (rfc-server §6.1, #310): async-generator server
  functions. Yields stream to the client as NDJSON
  (`{"chunk"}` lines, then `{"done":1}` / in-band `{"error"}` with the §5
  masking rules); the stub returns a lazy `AsyncIterable` — consumer
  `break`/`return()` aborts the fetch and the server generator's `finally`
  runs. String-yielding streams plug into `useStream` unchanged. Response
  headers/status freeze at the first yield; pre-yield throws are ordinary
  buffered JSON errors. The `/node` adapter now PUMPS response bodies with
  backpressure instead of buffering (long streams deliver progressively),
  and both authoring forms extract via `@sigx/vite/server`.
- `matchesServerFn(request, base = '/_sigx/fn')` on `@sigx/server/server`
  (rfc-deploy §2, #320/#321): the routing predicate platform entries compose
  with — pathname-under-mount-path match, method deliberately unchecked (a
  GET should reach the handler's 405, not the document handler).
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
