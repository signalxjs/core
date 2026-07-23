# Changelog

## [Unreleased]

### Changed

- **`form` is typed as the literal `true` (#437).** The extractor reads
  `form: true` statically and (since #412) the runtime requires `input` at
  definition time — but the TYPE still accepted any boolean, so
  `form: someBool` type-checked while silently failing extraction. The
  option is now `form?: true`; a non-literal is a compile error pointing at
  the real contract.

### Added

- **Options-form unvalidated-wire warning (#437).** #412's once-per-function
  `__DEV__` wire-args warning covered the direct form and `serverStream`;
  the options form WITHOUT `input` still received wire input silently. It
  now warns symmetrically (once per function, wire calls only, prod
  unchanged), teaching `input`. JSDoc on `input`/`handler` documents the
  inference contract: `S` comes from the schema or the handler annotation —
  with neither, the client stub's argument type silently becomes `unknown`.
- **`ServerFnTransport` is exported from `@sigx/server/plugin` (#437)** —
  the type needed to author `serverPlugin({ transport })` no longer has to
  be imported from the stubs entry (`./client`). `serverPlugin`'s declared
  return type is now core's `Plugin` (shape unchanged).
- **`ServerFnReadCache` joins the `browser` entry's type re-exports
  (#437)** — the one `.`-entry type that was missing from parity.

- **BREAKING (pre-1.0)**: `serverFn({ form: true })` without `input` is now
  a **definition-time error**, in dev and prod alike (#412). It was a
  `__DEV__`-only warning — silent exactly where it mattered: the no-JS form
  transport delivers an attacker-typed string map straight to the handler,
  and the validator is the only thing between them (rfc-server §5.2b). The
  throw fails at module load (boot/CI), never per-request. A deliberately
  raw form target declares an explicit pass-through Standard Schema; the
  error message shows the exact shape.

### Added

- **Unvalidated-wire-args dev warning (#412).** A direct-form `serverFn`
  (and `serverStream`) that receives wire arguments — over any transport,
  not in-process — now logs a once-per-function `__DEV__` warning: wire
  arguments are attacker-controlled and the direct form's parameter types
  are compile-time only. The remedy it teaches: the options form's `input`
  (Standard Schema) for `serverFn`; validating at the top of the generator
  for `serverStream`. Zero-arg functions and in-process (SSR-time) calls
  never warn; prod is unchanged. The README's new "Validation and the two
  forms" section documents the direct/options arity asymmetry as the
  explicit trade-off it is.

- **The app-plugin face: `@sigx/server/plugin` (#413, #411).** A new entry
  (the only one importing the sigx runtime — the dependency-free `./client`
  stub entry is untouched) exporting `serverPlugin({ transport, types })`
  for `app.use(...)`:
  - `transport` installs the stub transport (endpoint/headers/fetch) via
    `configureServerFn`, with teardown on the app's disposables that clears
    it only while it is still the active transport (dev warns when
    overwriting another app's live transport). Live clients only (browser,
    or a `declareLiveClient()` native client) — a per-request SERVER app's
    install skips the process-global seam, so one plugin in a shared
    `createApp` is safe on both sides.
  - `types` is the **one-registration story for custom types (#411)**: a
    single `TypeHandler[]` stamps BOTH the RPC wire codec
    (`__SIGX_SERVERFN_CODEC__`, now tag-keyed — same-tag re-registration
    replaces, so per-request server-app installs are idempotent) and the
    state/boundary registry (`provideTypeHandlers`: the DI token plus the
    browser `__SIGX_TYPE_HANDLERS__` mirror).
  - `registerWireTypeHandlers(handlers)` — the standalone wire-codec
    registration for app-less contexts (endpoint-only processes, zero-JS
    loader pages).

- **Single-flight boundary refresh — the wire** (rfc-server §6.3, #313).
  `serverFn({ refreshes })` declares which boundary components a mutation
  may refresh (array, or `(input, result) => keys` on the validated
  input). The endpoint gains `ServerFnRequestOptions.renderBoundaries` — a
  typed option the app wires (see `createBoundaryRefresh` in
  `@sigx/resume/server`); the request's `$boundaries` sidecar is
  shape-validated, capped, and filtered to the allowlist before the
  renderer sees it, and the response envelope carries the re-rendered
  entries as `$boundaries`. A renderer failure drops the refresh, never
  the mutation. The client stub (5th positional flag, emitted by
  `@sigx/vite/server` for declaring fns only) inventories the page through
  the new `__SIGX_SERVERFN_BOUNDARIES__` seam on the way out and applies
  entries (with a dispatch-order seq) on the way in — both throw-swallowed,
  both no-ops until `@sigx/resume/client` stamps the seam. Stub entry
  ceiling 2 KB → 2.1 KB (sits at 2.01 KB).
- **Zero-JS form actions — the endpoint half** (rfc-server §6.4/§5.2b,
  #312). `serverFn({ form: true, input, handler })` declares a **form
  target**: `handleServerFnRequest` accepts
  `application/x-www-form-urlencoded` and `multipart/form-data` for it —
  and only it; a form POST to anything else is a 415 (POST is an allowed
  method; the media type is what a non-target refuses). FormData
  normalizes to the options form's single input (flat object; repeated
  names → array; `File` passed through; values stay strings — Standard
  Schema coercion like `z.coerce.number()` is the mapping tool; dangerous
  field names dropped), runs the identical guard → validate → handler
  pipeline, and answers **303 POST-redirect-GET**: a handler-set
  `Location` wins, else back to the same-origin-validated `Referer`, else
  `/`. Every error on the form path renders as a minimal self-contained
  HTML page (`__DEV__` lists escaped validator issues; prod is generic) —
  the shape forks on the request content-type, so JSON callers of the
  same fn keep the envelope byte-for-byte. CSRF posture per §5.2b: the
  content-type layer is deliberately given up for declared form targets;
  Origin stays at full strength (an Origin-less form POST is 403 under
  the default policy). Form bodies are size-gated by `content-length`
  (413 over `maxBodyBytes`). `invalidates` never runs on the form branch
  (wire-only, §6.2). `__DEV__` warns on `form`+`cache` (a form target is
  a mutation) and on `form` without `input` (the validator is
  load-bearing, §5.2b). The build-stamped `action`/`method` attributes
  ship with the transform half.

- **Per-call `headers` and `fresh` on `.with(options)`** (rfc-server v2
  per-call options, #315 — completes the channel #353 opened with
  `signal`). `fn.with({ headers: {...} })(…)` sends one-off request
  headers, merged over `configureServerFn`'s transport headers (the
  per-call value wins) under the same rule — `content-type` is never
  overridable. `fn.with({ fresh: true })(…)` is §4.1's deferred freshness
  escape: on a cache-marked GET read the fetch runs with
  `cache: 'no-cache'`, so the browser revalidates with the origin instead
  of answering from `max-age`. Both are transport options: ignored with a
  `__DEV__` warning on in-process (SSR-time) calls — the mirror of
  `context` being ignored on the client — and `fresh` is likewise a
  `__DEV__`-warned no-op on POST (never HTTP-cached).
- **GET + cache semantics for idempotent reads** (rfc-server §4.1/§5.2a,
  #354) — the endpoint half. Declaring `cache: { maxAge, …}` on the options
  form marks a function a **side-effect-free idempotent read**:
  `handleServerFnRequest` now accepts GET for it (only for it — GET to
  anything else is a resource-precise `405 Allow: POST`; methods other than
  POST/GET answer `Allow: POST, GET` before symbol resolution), decodes the
  arguments from `?args=<encoded>` (the same JSON text a POST body carries,
  boundary-codec tags included, through the same reviver and error
  vocabulary), and emits `Cache-Control` from the declaration:
  `private, max-age=…` + `Vary: Cookie` by default;
  `public, max-age=…, s-maxage=…` under `public: true`'s args-only contract
  (§5.2a). `stale-while-revalidate` supported on both. A handler-set
  `cache-control` wins outright; **every non-2xx GET is `no-store`** (a CDN
  must never pin errors or 404s across a deploy). New endpoint option
  `maxUrlBytes` (default 8 KiB) answers oversized query strings with 414.
  Origin gets verify-when-present semantics on GET automatically — browsers
  send no `Origin` on same-origin GET; a present, mismatching one is still
  403. POST stays valid for every function; the guard/input/timeout/onError
  pipeline is identical on both methods; `invalidates` never runs on GET
  (`cache` and `invalidates` are mutually exclusive — `__DEV__` warns).
  `__DEV__` also warns when a `public` read touches `rq.request` (identity
  must not shape a shared-cacheable body).
- **GET stubs** — the client half of the same feature. `__serverFnStub`
  gains a 4th positional flag; when the `@sigx/vite/server` transform sees
  a `cache` declaration (presence-only, so a computed
  `cache: makePolicy()` still extracts) it stamps the flag and the stub
  issues `GET {endpoint}/{symbol}?args=<encoded>` — no body, no
  content-type, transport extra headers preserved, the envelope/`$cache`/
  error path shared with POST. `__DEV__` warns when the encoded arguments
  exceed ~2 KiB (too large to make a good cache key). No hash-seed change:
  the symbol already covers the call source, so toggling `cache` re-mints
  it and a stale client can never GET a symbol whose server half does not
  accept GET.
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
