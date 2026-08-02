# Changelog

## [Unreleased]

### Added

- **`@sigx/server/testing` — a public testing surface (#570).**
  `createTestServerFnContext(init?)` builds a real, Request-backed
  `ServerFnContext` (default `http://localhost/`) with zero ceremony:
  `rq.request`/`rq.url` never throw the detached error, `rq.status(code)`
  records to a readable `.statusCode` instead of dev-warning, caller
  `locals` keep their identity (one factory context across several
  `fn.with({ context: ctx })` calls is ONE request store; two contexts are
  two — the store-identity rule, now on public surface), and a previously
  built context as `init` is copied with guarded reads so throwing getters
  cannot crash it. `stampServerFnKey(fn, key?)` mints the build stamp
  `useData(fn)` requires (`__sigxKey`, default `test/<name>`, plus
  `__sigxGuardChecked`) on the SAME function — mutating because identity is
  load-bearing; streams are rejected in dev. There is deliberately NO new
  invoker: `fn.with({ context })(…)` already runs the whole in-process
  pipeline (preset guards → `use` chain → arity gate → `input` validation),
  and the README's new Testing section is that recipe. The detached-context
  error now names the factory as its third remedy.

### Fixed

- **The browser entry's type re-export list was unreachable, and completing it
  would have been worse (#565).** `browser.ts` hand-mirrored 14 type names from
  `index.ts` and had drifted three behind (`InvalidatePattern`,
  `ServerFnKeyRef`, `ServerStreamOptions`) — but nothing could ever see them:
  `package.json` routes `"types"` to `dist/index.d.ts` unconditionally, above
  the `browser` condition. That routing is correct and deliberate: the browser
  entry's values are throwing stand-ins whose signatures contradict the real
  API (`serverFn(): never` takes no arguments and is not generic), so a
  consumer resolving those types would fail to compile every `*.server.ts`. One
  type surface, two value surfaces. The list is gone, with the reason written
  where it used to be, and a test now pins the parity that does matter —
  VALUE-export parity between the two entries — plus the absence of a `types`
  key under `browser`.

  The `browser` condition also gained a `"default"`. A resolver that set
  `browser` but matched none of `development`/`production`/`import` fell out of
  the sub-object and continued at the parent, where the next match would have
  been the **server** module. In practice such a resolver hit "no conditions
  matched" instead, but this entry exists precisely so that class of
  misconfiguration fails loudly rather than shipping a server body to the
  client.

- **The pollution filters silently ate legitimate `constructor`/`prototype`
  data keys, in both directions (#560).** The request reviver, the response
  reviver in the client stubs, and the form-field filter all dropped three
  keys; only `__proto__` is actually dangerous (a prototype swap under
  assignment/merge) — `constructor`/`prototype` are plain own data keys. A
  server function returning `{ constructor: 'Acme Corp' }` lost the field
  on the client; a request argument or form field named `prototype` never
  reached the handler; nothing warned. All three filters now drop only an
  own `__proto__` key, and the drop dev-warns instead of being silent.
  `@sigx/serialize`'s revive guards the same key at the codec itself
  (#548), so the parse-time drops are defense in depth rather than the
  only line. The #544 prescan narrows with it — a body merely mentioning
  "constructor" in a value no longer takes the slow reviver path.

- **The form error path dropped `ctx.responseHeaders` (#557).** A guard
  that sets a rotating session cookie on `rq.responseHeaders` and then
  rejects delivered the cookie on JSON calls but silently lost it on native
  form submissions of the same function — same guard, same function,
  different transport, different observable behavior. `formErrorResponse`
  now merges the context's headers under its own load-bearing
  `Content-Type`/`Cache-Control`, exactly like the JSON path and the form
  303 success path already did. Applies everywhere a request context
  exists: guard vetoes, masked handler throws, timeouts, and a throwing
  `resolve` (#555). Pre-context refusals (origin, malformed path, unknown
  symbol) are unchanged — no guard has run, so there is nothing to carry.

- **A throwing `resolve()` escaped `handleServerFnRequest` (#555).** A
  rejecting symbol resolution — the prod registry's lazy `import()` after a
  partial deploy, dev's `ssrLoadModule` on a broken server module — left the
  handler entirely: no prod masking, no `onError`, no structured envelope. On
  Node it surfaced as the adapter's bare 500 / `next(err)`; on WinterCG as an
  unhandled fetch-handler rejection. It is now the standard masked failure: a
  thrown `ServerFnError` passes through verbatim (so a custom `resolve` can
  speak the wire language), anything else is a masked 500 reported to
  `onError`, with the error shape forked on the form transport as everywhere
  else.

  A body stream that errors mid-read (a disconnect mid-upload, truncated
  chunked encoding) had the same escape; it is now a structured
  `400 Malformed request body` — the JSON twin of the already-guarded
  `formData()` path — and deliberately not routed to `onError`, whose common
  cause would be every abandoned upload.

  `createServerFnHandler`'s `functions:` lookup is now own-property and
  callable-checked, so a prototype-key symbol (`POST /_sigx/fn/__proto__`,
  which used to resolve to `Object.prototype` and `TypeError` through the
  escape above) is a clean structured 404.

- **`createServerFnHandler` silently dropped `maxUrlBytes` (#545).**
  `ServerFnHandlerOptions` extends `ServerFnRequestOptions`, so the option
  type-checked — and did nothing. Every Node-adapter deployment (and the
  `@sigx/vite` dev middleware, which goes through the same function) fell back
  to the 8 KiB default, so a GET read's 414 fired at the wrong threshold. Inert
  since `maxUrlBytes` shipped in #354.

  The cause was the forwarding style, not the missing line: the adapter handed
  `handleServerFnRequest` a hand-written allow-list that had to be kept in sync
  by hand with an interface it *inherits* from. It now forwards by spread
  (`resolve` and `base` overridden with the resolved and normalized values), so
  the next option added to `ServerFnRequestOptions` cannot go missing the same
  way. The regression test drives `createServerFnHandler` over a real socket —
  the existing coverage all called `handleServerFnRequest` directly, which is
  precisely why this survived.

### Changed

- **`__sigxKey` is a string in every environment (#565).**
  `ServerFnCallable.__sigxKey` is declared a required `string`, and that
  declaration is load-bearing — it is what lets `useData(getVotes)` type-check
  while a plain function does not. Outside the Vite transform the property was
  simply absent, so `fn.__sigxKey.length` type-checked and crashed. Making it
  optional was not available: the gate is runtime-core's
  `ServerFnDataRef.__sigxKey: string`, and relaxing either side removes it
  entirely, because TypeScript skips weak-type detection for a type with call
  signatures — every function would satisfy it. The runtime was made honest
  instead: `serverFn()` mints `__sigxKey: ''` and `__serverFnStub` falls back
  to `''` when the build emitted no key. `''` is already what both readers mean
  by "absent" (`isServerFnDataRef` and the endpoint's invalidate-pattern
  resolver each test `key !== ''`), so keying, `useData(fn)`'s dev throw and
  fn-ref `invalidates` behave exactly as before. The client stub's own return
  type said `string | undefined` — a contradiction inside one package — and now
  says `string`.

  **What breaks is detecting "unstamped" by `undefined`**:
  `fn.__sigxKey === undefined`, or a test asserting `toBeUndefined()`.
  (`'__sigxKey' in fn` was already true on stubs.) Falsiness checks are
  unaffected, and nothing stops compiling.

- **A base mismatch now says so in dev (#563).** The mount `base` is spelled by
  `matchesServerFn`, by `handleServerFnRequest` and by the Node adapter, each
  defaulting to `/_sigx/fn` independently — so an app that moved its mount and
  updated only one of them 404'd every call with nothing to point at, and since
  #543 made `base` load-bearing for symbol extraction, a base wrong only in
  part mangles the symbol instead of missing cleanly. A request reaching a
  handler whose `base` does not describe it now carries a `__DEV__` warning
  beside the same 404 (production unchanged), naming the `serverFnBase` export
  a Vite build now provides on `virtual:sigx-server-fns`. Internally the three
  copies of the trailing-slash normalization collapsed into one `fnPathPrefix`,
  so `/rpc` and `/rpc/` cannot start routing differently in one of them.

- **BREAKING: `cache` + `invalidates` and `form` + `cache` are definition-time
  errors (#567).** Both pairs were dev-only `console.warn`s that left the
  function callable, and the endpoint then resolved the contradiction
  silently: a GET answer never carries `$cache.invalidates`, so the
  declaration was dropped — and because the patterns stayed undefined,
  single-flight boundary refresh (rfc-server §6.3) never ran for that mutation
  either. The production symptom was stale client caches and dead boundary
  refresh with no signal anywhere, which is exactly the case a `__DEV__`
  warning cannot reach. Both now `throw` from `serverFn()` in dev **and**
  production, matching the two neighbours that already did (`form` without
  `input`, #412; `unguarded` on a preset-derived function, #489) — a
  definition-time throw fails at boot or in CI, never per request, and throws
  are this package's only prod-visible channel. Both options' doc comments
  already said "mutually exclusive"; the throw makes the docs true.

  What breaks: a module declaring either pair now fails at module evaluation
  instead of loading. The realistic case is not a hand-written literal — both
  doc comments already forbade it — but **programmatically composed options**:
  `serverFn({ ...sharedReadOptions, invalidates })`, or a factory merging an
  options bag, which now fails at server boot rather than shipping a read
  whose invalidations silently did nothing. Fix by splitting: keep `cache` on
  the read, and move the write with its `invalidates` into its own `serverFn`.
  (The build already warned on a literal options spread, #437, so the two
  diagnostics now agree.) `form` + `cache` + no `input` still reports the
  `input` error first — that ordering is now pinned by a test.

  The endpoint keeps its `!isGet` guard as a wire-level belt for hand-stamped
  or registry-fabricated functions; it is no longer the place the
  contradiction is resolved.

- **Wire revive runs AFTER the endpoint `guard` (#559).** The codec's
  revive handlers do attacker-directed work — `$bigint` is a superlinear
  digit conversion, `$regexp` compiles an attacker's pattern, `$map`/`$set`
  construct arbitrary collections, and app-registered handlers run too —
  and all of it used to run before anything vetted the request. Argument
  revival now happens inside the request scope, after `guard`. Observable
  shifts: an unauthenticated request with a malformed encoded argument gets
  the guard's rejection (e.g. 401) instead of the reviver's 400, and the
  revive 400 now carries guard-set `responseHeaders` (#557). The guard's
  contract is unchanged — it reads `(ctx, info)` and never saw arguments.
  Deep nesting is refused by the codec itself at 256 levels (see
  `@sigx/serialize`'s changelog), surfacing as the standard
  `400 Malformed encoded value` on the request side.

- **`origin: 'verify-when-present'` no longer admits Origin-less FORM posts
  (#556).** The relaxation's safety argument is that browser CSRF stays
  blocked by the non-safelisted JSON content-type — and a `form: true`
  target deliberately gives that layer up, so combining the two silently
  reopened classic CSRF for exactly those functions: any requester that
  omits `Origin` (old browsers, Origin-stripping privacy proxies,
  hand-crafted form POSTs) could submit a credentialed mutation.

  Old vs new, per request shape under `'verify-when-present'`:
  JSON POST without `Origin` — admitted, unchanged. Form POST **with** a
  matching `Origin` — admitted, unchanged. Form POST **without** `Origin` —
  was admitted, now `403`. In dev the HTML page says "Form submissions
  require an Origin header" (distinct from the cross-origin message so the
  operator sees WHY); prod form error pages stay generic per the §5
  masking posture, as always.

  The pattern this breaks: a non-browser client crafting
  `application/x-www-form-urlencoded` POSTs to a form target without an
  `Origin` header under the relaxed policy. Send the header, call the
  function over the JSON RPC transport instead, or — for a deliberately
  public form endpoint — say `origin: false`, which remains the explicit
  escape hatch (allowlists also still work; they always required a present,
  listed `Origin`).

- **`runInScope` / `__SIGX_SERVERFN_SCOPE__.run` may return a non-promise
  (#544).** The request scope resolves its `AsyncLocalStorage` through a
  dynamic `import('node:async_hooks')`, and used to `await` that memoized
  promise on every single request — for a value that never changes after the
  first one. Only the first entry is asynchronous now; every one after it
  enters the scope synchronously, so the declared return type widened from
  `Promise<T>` to `T | Promise<T>`.

  Awaiting the result is unaffected, and that is what all three call sites in
  this repo do. **What breaks is treating the result as a thenable without
  awaiting it** — `runInScope(rq, fn).then(…)`, `.catch(…)`, `.finally(…)`, or
  passing it somewhere that requires a real `Promise` (`promise.then` feature
  detection, a `Promise<T>`-typed field). Wrap it: `Promise.resolve(runInScope(…))`,
  or just `await` it. One such call site existed in this package (the
  `timeoutMs` race's unhandled-rejection guard) and is fixed.

  Measured at 1.065 µs → 0.273 µs per scope entry.

- **The endpoint skips the prototype-pollution reviver when the request body
  provably cannot contain a dangerous key (#544).** `JSON.parse(body, reviver)`
  runs a per-key callback across the whole document; on a key-dense body that
  costs about 4× the parse itself. The reviver now runs only when the source
  text could actually SPELL `__proto__` / `constructor` / `prototype` — as a
  literal, or through a `\u` escape. Parsed output is identical in both
  branches, including for escape-spelled keys; the prescan is conservative in
  one direction only, so a body that merely mentions one of those words in a
  value takes the same path it always did.

  A POST whose arguments carry 400 keys got 2.2× faster end to end
  (417 µs → 186 µs); a trivial call with no arguments, 1.15× (23.6 µs → 20.1 µs).

- **BREAKING (wire): server-function request URLs no longer percent-encode
  (#355).** Inspecting a request meant reading `%40`/`%2F`/`%23` soup. Two
  independent causes, both fixed:

  - A stable symbol was `<stableId>#<name>` squeezed into ONE
    `encodeURIComponent`d path segment. It is now `<stableId>/<name>` spent as
    REAL path segments, encoded per segment, so `@`, `.`, `-`, `_`, `~` survive
    literally:

    ```
    - POST /_sigx/fn/%40acme%2Fapi%2Fsrc%2Fcart.server.ts%23addToCart
    + POST /_sigx/fn/@acme/api/src/cart.server.ts/addToCart
    - POST /_sigx/fn/cart%2Fadd            # serverFn({ id: 'cart/add' })
    + POST /_sigx/fn/cart/add              # the URL you wrote
    ```

    This also retires a documented deploy hazard: the README used to warn that a
    proxy or CDN which decodes or merges encoded slashes would mangle these
    routes. Nothing in front of the app has to cooperate any more.

  - A cache-marked GET read encoded its whole argument array into the query.
    When every argument is a simple scalar it now rides as named params —
    `?a0=shoes` instead of `?args=%5B%22shoes%22%5D`. Types survive because a
    param reads back as a number/`true`/`false`/`null` only when its raw text
    says so; a *string* that would be misread that way is JSON-quoted
    (`?a0="42"`), which is the only escape a scalar read can still produce.
    Anything richer (objects, `Date`, `Map`, `Set`, `BigInt`) falls back to the
    unchanged `?args=` blob for the whole call — never a mix, so the cache key
    stays a pure function of the arguments. Mixing the two explicitly, or a gap
    in the `a0, a1, …` sequence, is a 400 instead of a call with silently
    shifted arguments.

  **There is no compatibility path — deliberately.** No legacy registry key, no
  dual-format parsing. What breaks, and the fix:

  - a `role: 'client'` native build (lynx, terminal, installed app) posts the
    old stable route and gets the structured 404 its stub reads as version skew
    → rebuild and redeploy the client;
  - a long-cached page carrying a build-stamped `<form action>` 404s on submit
    → re-render it.

  Both were rfc-server N.3's deploy-durability promise; the section is amended
  to say the format changed once rather than that it never will. A test asserts
  the old form 404s, so the break is explicit rather than incidental.

- **`ServerFnRequestOptions.base`** (default `/_sigx/fn`) — the symbol is every
  path segment after the base now, so the handler has to know how much to strip.
  `createServerFnHandler` forwards its existing `base`; a deployment mounting
  `handleServerFnRequest` directly at a CUSTOM base must pass it, or
  multi-segment stable routes 404. A path outside the base is a 404 rather than
  a guess at the tail, and a malformed escape (`/%FF`) is now a 400 instead of
  throwing out of the handler into a masked 500.

- `__sigxKey` — the `useData`/`invalidates` cache key is the stable symbol, so
  it changes shape with it (`src/api.server.ts/getVotes`). Client and server
  deploy together, so nothing at rest breaks.

### Added

- **`requireGuards` + `unguarded: true` — forgetting a guard is now a build
  error (#489).** A `use:` chain is the only mechanism that runs on every
  transport, so a new `*.server.ts` that forgets one was silently unguarded on
  all five — and runtime cannot restore that guarantee without a registry whose
  miss would be fail-open. The build can. `sigxServer({ requireGuards })`
  requires every extracted `serverFn` **and `serverStream`** to be
  preset-derived, declare `use`, or declare `unguarded: true`; a bare one fails
  the build naming all three remedies, with file and line.

  **It defaults to `true`.** There is no installed base to wall in, and a
  guarantee shipped off by default ships to nobody — least of all to the apps
  that most need "you forgot a guard on this new module". `'warn'` is the
  migration rung; `false` is the deliberate opt-out for an app that authorizes
  inside handler bodies. `examples/resume` pays the price first: all six of its
  functions now say `unguarded: true`, which is true of them and is the
  demonstration.

  `unguarded` is a word rather than an omission because "I meant this to be
  public" and "I forgot" must not look identical, and because it makes the open
  surface greppable. Declaring it on a preset-derived function throws at
  definition time — the preset's guards still run, so the claim would be false.
  Two limits are stated rather than implied: the check verifies **declaration,
  not correctness** (`use: [logRequest]` passes), and a module outside
  `include`/`scan` is never analyzed — so the build stamps what it *did* check
  and dev warns on an unstamped call, making absence the alarm rather than a
  false pass.

- **`serverStream` gains an options form (#489).**
  `serverStream({ use, unguarded, handler })`, alongside the direct form. A
  stream is a public endpoint, so the gate holds it to the same rule — and it
  needed somewhere to declare. It also gives streams a first-class `use:`,
  which until now was reachable only through `preset.stream`. Deliberately no
  `input`: a stream takes many arguments and has no single-input shape to
  validate.

- **`perRequest` — a value computed once per request, typed without a cast
  (#494).** Work derived from the request (a decoded session, an authenticated
  API client, a request id) was recomputed by every call that needed it: a page
  with five SSR-enabled cells decoded the same session five times.

  ```ts
  export const session = perRequest(async (rq) =>
      decodeSession(rq.request.headers.get('cookie')));

  export const github = perRequest(async (rq) => {
      const s = await session(rq);          // the SAME memoized promise
      if (!s) throw new ServerFnError(401, 'Sign in');
      return createGitHubClient(s.token);
  });
  ```

  The accessor takes `rq` — no ambient lookup at the call site, the rule `rq`
  itself follows. Values compose by calling each other, with no composition
  API. The setup's return is memoized **promise included**, so a guard and a
  handler racing on first touch share one in-flight decode; a failed setup
  stays failed for that request; a setup that resolves itself throws "circular
  request value". Instances live on a non-enumerable
  `Symbol.for('sigx.serverfn.requestValues')` slot of `rq.locals`, so there is
  no new global seam and `locals` still spreads, logs and serializes clean.
  **No disposal in v1**, deliberately: on WinterCG runtimes a render's scope
  settles at the shell, so "released when the response has flushed" would fire
  mid-stream — teardown belongs to the app's own handler until the `keepAlive`
  scope extension lands. `perRequest` throws from the browser entry like its
  neighbours, which matters more than it looks: a `session.server.ts` exporting
  only per-request values has no `serverFn` to shout.

### Changed

- **A nested request scope MERGES into the enclosing one instead of clobbering
  it (#495).** `runInScope` replaced the stored value outright, and the
  document handlers always open their own inner scope with the raw request — so
  the README's own recipe,
  `runWithServerFnContext({ request, locals: { user } }, () => renderHandler(…))`,
  silently discarded the pre-seed and every call inside saw `locals: {}`. That
  is the first thing an app reaches for when it hits the missing per-request
  slot, so the two failures compounded. A nested scope for the **same request**
  now keeps the enclosing store: the inner source's fields win where supplied,
  and the enclosing `locals` stays the store, so one render has one store no
  matter how many times a scope is opened around it.

  **Same request = same URL + method.** Object identity was the alternative and
  is too strict to fix the bug it exists for — the Node path builds a fresh
  `Request` from the `IncomingMessage` on every scope entry, so identity would
  leave the recipe broken exactly where it is documented. Protocol is excluded
  from the comparison, since `socket.encrypted` and `x-forwarded-proto` are two
  legitimate normalizations of one wire request and a TLS-terminating proxy
  must not split the store. A source that names **no** request makes no claim
  and always merges — so `runWithServerFnContext({ locals }, …)` is the
  simplest pre-seed there is. Anything else opens a fresh store and `__DEV__`
  says so once per process, naming both keys; to isolate a nested render on
  purpose (a subrequest for a different principal), hand it its own `locals`.

- **The request scope stores `{ request, locals }`, not a bare `Request`
  (#494).** `rq.locals` is now genuinely shared by every in-process call in one
  request/render instead of being a fresh `{}` per call — it is the untyped
  face of the per-request store (`perRequest` is the typed one, and the
  recommended hand-off). **Observable, and the point**: a function writing
  `rq.locals.x` used to write into a bag nobody would ever read; now its
  siblings in the same render see it, and a guard that decodes a session can
  hand it to the next call. The wire path already behaved this way — the
  endpoint has always put its full context in the scope — so this makes the
  in-process path agree with it rather than inventing a rule, and nothing on
  the wire changes. A caller's own bag is kept by identity, so the documented
  `runWithServerFnContext({ request, locals }, …)` pre-seed is the store.

- **`serverFnPreset` — shared per-module middleware (#398).** A `use:` chain
  is the only mechanism that runs on **every** transport (the endpoint's
  `guard` is wire-only, #493), which made app-wide auth a line repeated on
  every function in every server module. `serverFnPreset({ use })` returns
  `serverFn`'s exact overloads bound to that chain, plus `preset.stream` for
  `serverStream`:

  ```ts
  export const appGuards = [requireUser];              // src/guards.ts

  const authed = serverFnPreset({ use: appGuards });   // src/board.server.ts
  export const boardIssues = authed({ input: BoardKey, handler });
  export const feed        = authed.stream(async function* (rq) { … });
  ```

  Preset guards run before the function's own `use:`. The array is copied at
  definition — a policy the app can mutate afterwards is not a policy. Not a
  builder: a preset carries `use` and nothing else and cannot derive another
  preset. Same-module only, because the extractors analyze one file at a
  time; exporting a preset is a build warning and using one in the inline
  (component-file) form is a build error, both naming the remedy — share the
  guard **array**. Editing the shared chain re-mints the hashed symbols of
  every function derived from it, the way editing a body already does; stable
  symbols (`<id>#<name>`) never move.

### Fixed

- **An SSR-time `serverStream` ran no middleware at all (#398).** Its
  in-process wrapper called the generator directly instead of going through
  the invoke pipeline, so a stream that was fully guarded over the wire was
  completely unguarded during a render — the same transport asymmetry #493
  documented for the endpoint `guard`, in miniature. In-process streams now
  run the same pipeline the wire does. Observable consequence: a guard veto
  rejects on the **first pull** rather than at the call, which is exactly
  where the wire path's pre-first-yield error already surfaced. The call
  itself stays synchronous, and consumer cancellation still reaches the
  implementation's `finally`.

- **The direct form had no middleware seam at all (#398).**
  `serverFn(async (rq, …) => …)` accepted no `use:` and had no loop to
  prepend one to, so a preset's guards would have silently not run there. It
  now runs its preset chain — inside the direct branch, so a multi-argument
  direct-form function is unaffected by the options form's single-input
  arity check.

- **Documentation: the endpoint `guard` is wire-only (#493).** The README, the
  `ServerFnRequestOptions.guard` JSDoc and `rfc-server.md` described it as
  running "before every function, for every transport — the app-wide auth
  seam". It runs inside `handleServerFnRequest`, so it covers the wire
  transports only: an **in-process (SSR-time) call** never enters the handler
  and runs just that function's own `use:` chain. An app relying on `guard`
  alone had guarded RPC calls and unguarded renders. No runtime change — the
  contract is now stated as it always behaved, and auth that must hold on every
  transport belongs in each function's definition. See `docs/rfc-server-v3.md`
  §1 for the mechanism that removes the per-function repetition (#489).

- **Options-form `serverFn` with an input-less handler is now a zero-argument
  callable (#451).** `serverFn({ handler: async () => … })` used to infer its
  input as `unknown`, so calling the wrapped fn as `fn()` was a compile
  error ("Expected 1 arguments, but got 0"). The options overload's input
  type parameter now defaults to `void` when nothing infers it — no schema
  and a `handler(rq)` / `handler()` signature — and the callable takes zero
  arguments. Handlers that declare an input (via `input` schema or a typed
  second parameter) are unaffected. Type-level only; no runtime change.

### Performance

- **The §6.3 boundary-refresh gate no longer re-`JSON.stringify`s each
  `invalidates` pattern per dep (#469).** The gate is descriptors × deps ×
  patterns (up to 32 × 32 × 64), and a tuple pattern's canonical form was
  re-derived on every comparison — up to ~65k `JSON.stringify` calls per
  mutation, before any rendering and inside the request's `timeoutMs`. Each
  pattern is now canonicalized once before the filter; at the worst allowed
  shape the gate drops from ~16.8 ms to ~2 ms. Same admission semantics. (The
  identical matcher in `@sigx/cache`'s `invalidate()` got the same fix.)

### Changed

- **BREAKING (pre-release)**: **`refreshes` is REMOVED — boundary refresh
  keys off `invalidates` (#452).** The §6.3 sidecar/refresh path now
  belongs to the `invalidates` declaration: the stub's sidecar flag means
  "invalidates-declaring", descriptors carry the boundary's recorded
  `deps` (validated: ≤32 keys/descriptor, ≤1024 chars/key; dep-less
  descriptors dropped — they can never be admitted), and the endpoint
  admits `deps ∩ invalidates` under `keyMatches` semantics (duplicated
  from `@sigx/cache` in `server/key-match.ts` with a parity test — no
  dependency edge). `__sigxRefreshes` and the `cache`+`refreshes` dev
  warning are gone; the `invalidates` patterns are computed ONCE per call
  and shared by `$cache` and the gate. Migration: replace
  `refreshes: ['Poll']` with `invalidates: () => [getVotes]` and read the
  data via `useData(getVotes)`.

- **`form` is typed as the literal `true` (#437).** The extractor reads
  `form: true` statically and (since #412) the runtime requires `input` at
  definition time — but the TYPE still accepted any boolean, so
  `form: someBool` type-checked while silently failing extraction. The
  option is now `form?: true`; a non-literal is a compile error pointing at
  the real contract.

### Added

- **`serverStream` gains the `.with()` per-call channel (#448).** #362 gave
  `serverFn` a per-call options bag and left streams out on the strength of
  the `signal` argument alone (a consumer's `break`/`return()` already
  aborts the fetch). That said nothing about the other two options, and both
  gaps were real: an in-process (SSR-time) stream had no way to be handed a
  request, so a generator reading `rq.request`/`rq.url` threw unless a
  `runWithServerFnContext` scope happened to be on the stack — the exact
  failure `.with({ context })` (#352) exists to fix on runtimes without ALS
  — and `__serverStreamStub` took no options at all, so per-call `headers`
  (#315) never reached a stream. `serverStream` callables and their
  generated stubs now carry `.with(options)` with the same semantics and the
  same mirrored ignores (`context` dev-warns on the client, `headers`
  dev-warns in-process). `fresh` is deliberately **not** in the type
  (`ServerStreamCallOptions = Omit<ServerFnCallOptions, 'fresh'>`): a stream
  is always POST and is never answered from an HTTP cache, so it is a
  compile error instead of a silent no-op. A caller's `signal` composes with
  (never replaces) the stub's internal abort, so consumer `break`/`return()`
  behaves exactly as before, and `AbortSignal.any` is only reached when
  someone opts in — the zero-config path is byte-for-byte the call it was.
  New exported types: `ServerStreamCallOptions`, `ServerStreamCallable`. No
  build/transform change — emitted stub modules are identical.

- **Options-form unvalidated-wire warning (#437).** #412's once-per-function
  `__DEV__` wire-args warning covered the direct form and `serverStream`;
  the options form WITHOUT `input` still received wire input silently. It
  now warns symmetrically (once per function, wire calls only, prod
  unchanged), teaching `input`. JSDoc on `input`/`handler` documents the
  inference contract: `S` comes from the schema or the handler annotation —
  with neither the input is undeclared, and the callable takes no argument
  (see the `[Unreleased]` Fixed entry for #451). Undeclared is a typing
  statement, not a gate: the wire can still carry an input, which is what
  this warning is for.
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

- **Stable data keys + fn-ref `invalidates` (#452).** Wrapped fns and
  client stubs carry the build-stamped `__sigxKey` (`<stableId>#<name>`;
  the stub takes it as a new 4th positional, shifting the GET/refreshes
  flags to 5th/6th). `invalidates` patterns may now be server-fn
  references — bare (`() => [getVotes]`) or embedded in tuples — and the
  endpoint resolves them to plain stable-key tuple patterns before
  attaching `$cache.invalidates`, so the wire format (and `@sigx/cache`)
  is unchanged. A reference with no stamped key can match nothing: its
  pattern is dropped with a `__DEV__` warning. New exported types:
  `ServerFnKeyRef`, `InvalidatePattern`; `ServerFnCallable` declares
  `__sigxKey` (build-stamped) for `useData(fn)` keying DX.

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
