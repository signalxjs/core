# Changelog

## [Unreleased]

### Added

- **Renders are scoped automatically** (#309). `runWithServerFnContext` now
  publishes its runner as the `__SIGX_SERVERFN_SCOPE__` seam, which
  `createRequestHandler` / `createFetchHandler` use to wrap every document
  render — so SSR-time `rq.request` works with no wiring in the app, and dev
  behaves like production. The endpoint scopes its own invocation too: a server
  function calling another in-process now inherits the live request instead of
  dropping to the detached context.
- The runner moved from `./node` to a shared module reachable from `./server`,
  so **WinterCG entries get it by import alone** (`node:async_hooks` is still
  imported dynamically, so nothing is pulled at load). Where that import fails
  — workerd without `nodejs_compat` — the scope degrades to running unscoped
  instead of throwing: a missing compatibility flag must not 500 a site.
  `runWithServerFnContext`'s public signature is unchanged.
- A Node `IncomingMessage` is accepted as a scope source and normalized to a
  `Request` (forwarded-proto/host aware) — `createRequestHandler` holds one of
  those, not a `Request`.
- **Request context for in-process (SSR-time) calls** (rfc-server §7 v1.1, #309 + #352). The most common server-function shape — `sessionFrom(rq.request)` — worked over RPC and **threw** the moment the same function was called during SSR, because an in-process call has no request to expose. Two ways to supply one now, most explicit first: `fn.with({ context: request })` per call (#352), and `runWithServerFnContext(request, fn)` from `@sigx/server/node` (#309), which uses `AsyncLocalStorage` so every server function called anywhere inside the scope sees it — including `serverStream`, which has no `.with()` channel. `context` takes a `Request` or a partial `ServerFnContext`. Explicit wins over ambient; with neither, the descriptive throw stays, because a function reading `rq.request` when nothing supplied one is a bug worth seeing rather than a silent `undefined`. `rq.responseHeaders`/`rq.status()` remain inert either way — there is no HTTP response to affect. On the client `.with({ context })` is ignored with a `__DEV__` warning (a stub's context is the request it makes), which costs the size-limited stub entry nothing.

  **WinterCG story**: `runWithServerFnContext` imports `node:async_hooks` **dynamically**, so merely loading `@sigx/server/node` does not pull it on a runtime that lacks it — only calling the function does. It needs Node, Deno, or workerd with `nodejs_compat`; everywhere else `.with({ context })` behaves identically and needs no ALS. The ambient request reaches the core through the `__SIGX_SERVERFN_CONTEXT__` seam (`docs/seams.md`) rather than a module variable, because `.` and `./node` are separate dist entries and dev can hold two copies of a module — the same hazard that makes `ServerFnError` a brand check. The seam is re-stamped on every scope entry, not just the first: a store nothing can read is a worse failure than a redundant assignment.

- **Rich wire serialization, both directions** (rfc-server §4, #364). A
  returned `Date` used to arrive as a string — while TypeScript still
  reported `Date`, so `.getTime()` threw in production. `Map`/`Set` arrived
  as `{}`, explicit `undefined` properties vanished, and a `BigInt` threw in
  `JSON.stringify` and became a masked 500. All of those now round-trip, on
  **arguments as well as results**, plus stream chunks and
  `ServerFnError.data`. Built-in vocabulary, zero configuration: `$date`,
  `$map`, `$set`, `$bigint`, `$url`, `$regexp`, `$undef`. Custom classes
  register through `globalThis.__SIGX_SERVERFN_CODEC__` (the `$cache`
  global-seam pattern) and are consulted *before* the built-ins. **The
  envelope shape is unchanged** — tags live inside the values, so
  `{"args": […]}` / `{"data": …}` and the `$cache` sidecar are untouched, and
  no version field is needed: an unrecognized tag passes through rather than
  throwing, so peers on different versions degrade instead of breaking. A
  user object shaped like a tag (`{ $date: 'a string' }`) is escaped and
  comes back intact. Decoding runs *after* the prototype-pollution reviver,
  and a malformed tag payload in a request is a **400**, not a masked 500.
  Circular structures remain the one unsupported shape and still fail.

### Removed

- **`warnNonJsonSafe`, the #351 dev guardrail.** It existed only to make the
  JSON-only wire's silent corruption visible in dev; the wire now carries
  those types for real, so the warning is gone rather than misleading. No API
  change — it was never part of the public surface.

- **`onError` observability hook** on the endpoint options (`/server` +
  `/node`): called for every MASKED failure — any non-`ServerFnError` throw
  from guard or handler, mid-stream `serverStream` throws, and timeouts —
  in dev AND prod, awaited before the response; its own throws are
  swallowed. Prod masking itself is unchanged (the caller still sees the
  generic 500); this is the server-side trace that previously did not exist
  outside `__DEV__`. (#349)
- **`timeoutMs`** on the endpoint options: an opt-in upper bound on
  guard + handler (+ a stream's first chunk). On expiry the caller gets a
  504 `Server function timed out`, `rq.abortSignal` fires (merged with
  client disconnect via `AbortSignal.any`), and `onError` receives the
  timeout error. A started NDJSON stream is not bounded — the timeout
  covers time-to-first-byte only. (#350)
- **`.with(options)` per-call channel** on every `serverFn` callable
  (`serverStream` deliberately excluded — consumer `break`/`return()`
  already aborts its fetch) —
  `search.with({ signal: ctx.signal })(arg)` forwards an `AbortSignal` into
  the stub's fetch (aborting fires `rq.abortSignal` server-side) and, on
  in-process (SSR) calls, becomes `rq.abortSignal` directly. Explicit by
  design: the wire args stay exactly your args, no trailing-argument
  sniffing. This is rfc-server v2's "per-call options" channel pulled
  forward with its first option; `headers` joins it in v2. New exported
  types: `ServerFnCallOptions`, `ServerFnCallable`. (#353)
- **Dev warning for non-JSON-safe results**: until rich type serialization
  ships with the revive seam (rfc-server §4), a result containing a `Date`,
  `Map`/`Set`, class instance (without `toJSON`), or `undefined`-valued
  property triggers a single `__DEV__`-only `console.warn` naming the path
  — the silent Date-becomes-string prod bug becomes a visible dev nudge.
  The wire is never transformed. (#351)

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
