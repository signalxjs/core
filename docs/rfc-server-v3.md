# RFC: rfc-server v3 — request-scoped context & guard completeness

Status: **proposed**. Tracking: signalxjs/core#491.
Amends `rfc-server.md` §2.1 (`serverFnPreset`, #398) and **re-opens** its §2.2
(`defineServerService`, #399) — that section is a candidate here, not a
premise. Pre-1.0, no-compat, same stance as the parent RFC: one way to do it.

Everything below is stated against the code as it exists at
`d624fea`, with `file:line` evidence. Where the parent RFC and the code
disagree, the code wins and the parent RFC is corrected (§4).

Grounded in one real application: **signalxjs/pulse**, whose entire serverFn
surface requires a signed-in user, which runs on Node in dev and workerd
(Cloudflare + D1) in production, and which streams SSR documents. Every number
in the problem statement is measured there.

---

## Problem — stated against the current code

### P1. The app-wide auth seam is wire-only (#489, #493)

`rfc-server.md` says app-wide auth belongs to the endpoint's `guard` option and
that it runs "unconditionally before every function, for every transport"
(`rfc-server.md:315-319`, `:809`, `:1000-1003`), and
`packages/server/README.md` repeats it under **Security defaults**. It is not
true.

`options.guard` is invoked at `packages/server/src/server/index.ts:637`, inside
`handleServerFnRequest`. That covers the four **wire** transports — POST JSON,
GET cache-marked read (§4.1), native form POST (§6.4), NDJSON stream. A server
function called **in-process** — which is what `useData` does during SSR — never
enters that handler: the wrapper at `packages/server/src/index.ts:259-274` calls
`invoke` directly, and `invoke`'s only middleware is the per-fn `use:` array
(`index.ts:230-232`).

So an app that mounts `guard: requireSession` and writes no per-fn chains has
**guarded wire calls and unguarded renders**. That is precisely the "separate
middleware universe to forget" that §5 claims sigx does not have — Qwik's
`server$` trap, reproduced.

Pulse discovered this the hard way and repeats `use: [withAuth]` on **14 of 15**
server functions across three `*.server.ts` modules, with a comment explaining
why. The repetition is the workaround; #489 is the request to remove it *without
losing the transport guarantee*.

### P2. There is no per-request slot (#494)

The ambient scope stores a bare `Request` (`scope.ts:159-165`), and every
in-process call materializes its own context from it — `contextFrom`
(`context.ts:85-113`) ends with `locals: partial.locals ?? {}`. So `rq.locals`
is a **fresh empty object at the start of every in-process call**: a guard that
decodes a session cannot hand it to the next call, and a function that builds an
API client cannot reuse it.

(The wire path is unaffected: the endpoint puts the full ctx in the scope at
`server/index.ts:636`, so calls nested under one wire request do share `locals`.
It is the SSR document path — the one that matters for renders — that has
nothing.)

Measured, one signed-in SSR render of Pulse's `/`:

1. the document handler decodes the session — cookie parse → HMAC verify →
   D1 `SELECT * FROM sessions` → **AES-GCM decrypt** of the stored token;
2. `viewerOrgs` → `withAuth` → the same four steps again, plus a GitHub client;
3. `viewerRepos` → `withAuth` → a third time, plus a **second** client.

The board page renders 5-7 cells and pays it 5-7×. The app's ETag cache is
hoisted to process scope precisely because there is nowhere per-request to put
it.

### P3. The typed hand-off is a cast

`rq.locals` is `Record<string, unknown>`, deliberately (`rfc-server.md:558-560`:
"if a local wants a type, it wants to be a service"). With no service mechanism
shipped, apps land on the obvious workaround — Pulse's is

```ts
export function authed(rq: ServerFnContext): AuthedLocals {
    return rq.locals as unknown as AuthedLocals;   // a runtime no-op that lies
}
```

one of only two unsafe casts in the whole application. Nothing links
`use: [withAuth]` to that type: a function that forgets the guard still
typechecks and crashes on `undefined.gh` at runtime.

### P4. Four facts the locked design does not survive

Found while planning the implementation; each changes a decision, not just code.

- **F-A — `createFetchHandler` settles its scope at the shell.**
  `packages/server-renderer/src/server/fetch-handler.ts:163` returns the
  `Response` from *inside* `withServerFnScope`, so the scope promise resolves
  while the body is still pumping. The Node twin awaits `body.on('end')`
  (`server-renderer/src/node.ts:237-251`) and does not. §2.2 promises request
  services are disposed "after the response has fully flushed (streams
  included)" — on **every WinterCG/edge deploy** that would fire mid-stream,
  closing `useTrace` spans early and tearing services down under live `useData`
  continuations. The promise cannot be kept without extending the
  `__SIGX_SERVERFN_SCOPE__` contract.
- **F-B — the direct form has no guard seam, and `serverStream` bypasses its own
  pipeline.** `index.ts:197-210` is a bare `return arg(rq, ...args)` — there is
  no loop to prepend to. And `index.ts:394` calls `impl(...)` directly rather
  than `invoke`, so **an SSR-time stream runs zero middleware today** and has
  nowhere to hook one. Related: #398's checklist wording ("route the direct form
  through the options invoke") would 400 every multi-arg preset function — the
  options invoke rejects `args.length > 1` (`:235-237`), and §2.1's own example
  is a two-arg direct form (`rfc-server.md:347`).
- **F-C — `streamResponse` has four terminal paths, not three**
  (`server/index.ts:929-931` empty-generator close, `:939-941` done close,
  `:961-962` error close, `:965-967` cancel). §2.2 names three; an empty
  generator would never dispose.
- **F-D — nested scopes clobber (#495).** `runInScope` replaces the ALS store
  (`scope.ts:159-165`), and the document handlers always open their own inner
  scope with the raw request (`server-renderer/src/node.ts:199`,
  `fetch-handler.ts:119`). So the README-documented recipe
  `runWithServerFnContext({ request, locals }, () => renderHandler(...))`
  **silently loses the locals** — the first thing an app reaches for when it hits
  P2.

---

## §1 Guard completeness (#489)

### 1.1 The mechanism has to be definition-level

Enumerate the ways a chain could reach every transport, and only one survives.

- **On the mount** (`createServerFnHandler({ use })` — the literal ask). Runs
  inside the endpoint; in-process calls never reach it. Fails by construction.
- **In a process-level registry** consulted by `invoke`. Reaches every
  transport, but it needs a `globalThis` seam — in dev the Vite module runner
  and Node hold two copies of the same module, the hazard documented at
  `context.ts:56-65` — and `docs/seams.md` requires a seam's miss to be **a
  no-op, never a throw**. On the auth path a no-op miss is fail-open: it would
  be the first seam in the registry whose absence is a security hole. It also
  makes a function's behavior depend on process state, so a unit test calling
  the function directly and production disagree, and it has an ordering hazard
  (anything invoked before registration runs unguarded, undetectably).
- **On the request scope.** Absent by design where there is no
  `AsyncLocalStorage` (workerd without `nodejs_compat` — `scope.ts:126-131`
  calls that a *supported* state), bypassed by `fn.with({ context })`
  (`context.ts:144`) and by the detached context, and opened by
  `@sigx/server-renderer`, which cannot import `@sigx/server`, with the raw
  request. Three silent fail-open paths.
- **In the definition.** Captured in the wrapper when the function is defined,
  read by the one `invoke` every transport shares. No lookup, no ordering, no
  platform dependency. This is what `use:` already is.

**Decision: the chain is definition-level. `serverFnPreset` (§2.1) stands as the
mechanism.** What changes is what it covers (§1.2), how a public function opts
out (§1.3), and how an app knows nothing was forgotten (§1.4).

The repetition #489 objects to is answered by sharing the guard **array**, not
the preset:

```ts
// src/guards.ts — the one place the policy lives
export const appGuards = [requireUser];

// src/board.server.ts, src/repos.server.ts, src/mutations.server.ts
const authed = serverFnPreset({ use: appGuards });
export const boardIssues = authed({ input: BoardKey, handler: async (rq, k) => … });
```

Pulse's 14 declarations become 3, and adding an app-wide guard becomes a
one-line edit in one file. What remains per-module is one line — the price of a
guarantee that has no runtime lookup in it.

### 1.2 `serverFnPreset`, amended (F-B)

Two additions to the locked §2.1, both forced by holes that exist independently
of presets:

```ts
export function serverFnPreset(base: { use: ServerFnGuard[] }): ServerFnPreset;

/** serverFn's exact overloads, plus the serverStream twin. NOT a builder:
 *  `preset.stream` is a second one-shot factory over the same `use` array,
 *  never an accumulating chain (the non-goal stands). */
export type ServerFnPreset = typeof serverFn & { stream: typeof serverStream };
```

- **The direct form gains guards.** `index.ts:197-210` grows the same loop the
  options form has. Implementation note, recorded because #398's checklist says
  otherwise: the guards are prepended **inside each existing branch**, not by
  routing the direct form through the options invoke — that invoke rejects
  `args.length > 1`, and a two-arg direct-form preset function is §2.1's own
  headline example.
- **`serverStream`'s in-process wrapper is rerouted through `invoke`**
  (`index.ts:394`). Today an SSR-time stream runs no middleware at all — no
  `use`, nothing — while the same stream over the wire is fully guarded. That
  is P1 in miniature and it is fixed here whether or not presets ship.
- The preset copies its `use` array once at definition (`base.use.slice()`): a
  policy an app can mutate after the fact is not a policy.
- Everything else in §2.1 holds unchanged — same invoke pipeline, same `.with()`
  channel, same wire, same envelope, statically-read options (`id`, `cache`,
  `invalidates`, `form`) stay at the call site, preset source text mixes into
  the hashed-symbol seed, same-module contract, exported preset becomes a
  `__serverOnly` stub with a targeted warning.

### 1.3 The opt-out is a word, not an omission

Every real app has public functions — Pulse's `submitPat` is the sign-in target
itself and must not require a session. An opt-out that is spelled as *absence*
("just don't add the preset") is indistinguishable from a mistake, so it is
spelled as a word:

```ts
export const submitPat = serverFn({
    unauthenticated: true,     // deliberate: this IS the sign-in
    form: true,
    input: PatSchema,
    handler: async (rq, pat) => …
});
```

- **Runtime-inert; the build reads it statically.** Literal `true` only, the
  same discipline `form` already has (#437).
- **Contradicting a preset throws at definition time.**
  `authed({ unauthenticated: true })` is a lie — the preset's guards still run —
  and it fails at module load, in the same non-`__DEV__` channel as the existing
  `form`-without-`input` throw (`index.ts:291-306`). Boot/CI, never per-request.
- **It makes the public surface greppable.** `grep -rn unauthenticated
  --include='*.server.ts' src/` prints every deliberately-open endpoint in the
  app — a list a security review can read, which nothing produces today.

### 1.4 The guarantee is a build gate

A preset per module is a mechanism, not a guarantee: a new `*.server.ts` that
forgets the line is unguarded on **all five** transports. Runtime cannot restore
the guarantee without the fail-open registry §1.1 rejected. The build can.

```ts
// vite.config.ts
sigxServer({ requireGuards: true })     // or 'warn' during migration; default false
```

Every extracted server function must be **preset-derived**, declare **`use`**, or
declare **`unauthenticated: true`**. A bare `serverFn(async (rq) => …)` is a
build error naming both remedies, with its file and line.

Default `false`, deliberately: an app that authorizes inside handler bodies is a
legitimate shape (the parent RFC's own opening examples do), and defaulting to
`true` would wall existing apps into errors.

This is the extractor's existing kind of work. It already presence-detects
options keys (`hasServerFnOptionKey`, `server-fn-extract.ts:184`, used for
`cache`/`invalidates`/`form`) and already resolves which local identifier is a
`serverFn` (pass 1, `:307-330`). It needs: preset locals in that pass, a `use`
presence read, and an `errors` channel beside `warnings` for the file form — the
inline form already has one (`server-fn.ts:444-457`). The check is re-exported
from `@sigx/vite/server-extract` so the non-Vite (lynx/Rspack) loader enforces
the same rule (N.5).

### 1.5 The residual gap, stated

- **The check verifies declaration, not correctness.** `use: [logRequest]`
  passes. That is the honest limit: it converts "silently unguarded" into "a
  list a human wrote", which is the unit a review can act on.
- **A `*.server.ts` outside `include`/`scan` is never analyzed** — and
  `sigxServer({ scan })` exists because that happens (workspace packages outside
  the Vite root). Mitigation: under `requireGuards` the extractor stamps
  `__sigxGuardChecked` alongside the `__sigxKey` stamps it already appends
  (`server-fn-extract.ts:280-290`), and `__DEV__` warns when a function without
  the stamp is invoked. Absence is the alarm, so a missing signal degrades to
  silence rather than a false pass.
- **A production build with an unanalyzed module stays silently unguarded.** Dev
  catches it; prod does not. No candidate on the list closes this, and the two
  that claim to (registry, scope) fail open in more places.

---

## §2 Request-scoped context — re-opened

`rfc-server.md` §2.2 (`defineServerService`) is a candidate here, not the
premise. This section states the requirement from the evidence, evaluates the
options, and picks — with the argument on the record either way.

### 2.1 The requirement

Work derived from a request — a decoded session, an authenticated API client, a
request id, a trace span, a per-request transaction — must be:

1. computed **once per request/render**, no matter how many functions in that
   flow need it;
2. reachable from every guard and handler on **every transport**, wire and
   in-process alike;
3. **typed without a cast** (P3);
4. and, for anything holding a resource, released when the response is done.

Requirement 4 is the only one the measured problem does not demand — Pulse's
per-request values are a decoded session and a fetch client, neither of which
needs teardown. Note that, because it is where all the difficulty lives (§2.6).

### 2.2 The options

**(A) `defineServerService` as locked** — two lifetimes (`'request'` /
`'process'`), `ctx.rq` + `onDispose`, ambient-or-explicit resolution,
`overrideServerService`, `CTX_SOURCE` keying, a new `__SIGX_SERVERFN_SERVICES__`
global. It meets all four requirements. The case against it, stated as fairly as
the case for it:

- It is a **DI container** in everything but name — lifetimes, a resolution
  graph, a captive-dependency rule, a test-time override seam — inside an RFC
  whose non-goals reject "the DI-container meta-framework this RFC exists to not
  be" (`rfc-server.md:1607-1614`). The distance between "a container" and "not a
  container" here is mostly vocabulary.
- **The `'process'` lifetime largely restates §1.5.** "Services are modules" —
  and a module-level `const pool = createPool()` already *is* a lazy-enough
  process singleton with an import graph for a dependency list. What `'process'`
  adds over that is disposal-on-test-restore; what it costs is the
  captive-dependency rule, the throwing `rq` getter, `overrideServerService`,
  and a second store to key and reason about. That is a large surface for one
  benefit that `vi.mock` also provides.
- **The bare `useX()` form reintroduces ambient resolution at the call site** —
  the exact thing the parent RFC rejects for `rq` itself: "no ambient
  `getRequestEvent()` global (Solid) at the CALL site — the context is always a
  parameter, which is what makes the in-process SSR call semantics obvious"
  (`rfc-server.md:307-314`). Having argued that, offering `useSession()` with no
  argument re-opens it, and drags in the no-fallback throw to make the failure
  legible.
- It is also the option F-A and F-C bite hardest (§2.6).

**(B) One per-request store, two faces.** The scope carries a single per-request
store. `rq.locals` is its **untyped** face — the API is unchanged, but it is now
genuinely shared across every call in one flow instead of a fresh `{}` per call.
A small memo accessor is its **typed** face. One lifetime. No new global.

**(C) Shared `locals` only.** (B) without the typed accessor. Solves the
measured cost with a two-line memo in the app's own guard; leaves P3 (the cast)
unsolved.

**(D) Do nothing** — document that per-request memoization is the app's job.
On the record so the null option was considered; 3-7× a cookie-parse + HMAC +
database read + AES-GCM decrypt per render argues against it.

### 2.3 Decision: (B)

The store is one object per request, and it is the one every path already
builds: **`rq.locals`**.

```ts
// packages/server/src/scope.ts — the scope normalizes its source ONCE
runInScope(request, fn)   // stores { request, locals: {} }, not a bare Request
```

`contextFrom` already prefers a supplied `locals` (`context.ts:111`), so every
context derived inside that scope shares the one bag — no new machinery, one
changed line at the scope boundary. The wire path already behaves this way
(`server/index.ts:636` puts the full ctx in the scope), so this makes the
in-process path agree with it rather than inventing a rule.

On top of it, one typed accessor:

```ts
/**
 * A value derived from the request, computed at most once per request and
 * shared by every guard, handler and nested in-process call in that flow.
 * The accessor takes `rq` — the ctx-first idiom, no ambient lookup.
 */
export function defineRequestValue<T>(
    setup: (rq: ServerFnContext) => T
): (rq: ServerFnContext) => T;
```

```ts
// src/session.server.ts
export const session = defineRequestValue(async (rq) =>
    decodeSession(rq.request.headers.get('cookie')));

export const github = defineRequestValue(async (rq) => {
    const s = await session(rq);                    // the SAME memoized promise
    if (!s) throw new ServerFnError(401, 'Sign in');
    return createGitHubClient(s.token);
});

// src/guards.ts
export const requireUser: ServerFnGuard = async (rq) => {
    if (!(await session(rq))) throw new ServerFnError(401, 'Sign in');
};

// src/board.server.ts
const authed = serverFnPreset({ use: [requireUser] });
export const boardIssues = authed({
    input: BoardKey,
    handler: async (rq, key) => (await github(rq)).issues(key),   // no decode, no cast
});
```

What this buys against §2.1's four requirements: (1) one decode per render —
Pulse's 3-7× becomes 1×; (2) the same store on every transport, because it rides
the context every transport builds; (3) `github(rq)` is typed by its own setup —
the `as unknown as AuthedLocals` cast disappears; (4) deferred, see §2.6.

What it costs relative to (A): no `'process'` lifetime (module scope is the
answer, per §1.5), no override seam (a request value is reached through a
module, so it mocks like any module), no captive-dependency rule (it cannot
exist with one lifetime), no ambient no-arg form, and no new global seam. The
whole mechanism is roughly fifty lines.

**Naming** is open: `defineRequestValue` reads as "a value, per request" and
matches the `define*` family (`defineInjectable`, `defineFactory`,
`defineProvide`). `defineRequestScoped` and `requestMemo` are the alternatives
considered; the first is longer for no gain, the second under-sells that this is
the typed hand-off, not a cache.

### 2.4 Keying, and why no new seam

Instances live in the store they are keyed by: a slot on `rq.locals` under
`Symbol.for('sigx.serverfn.requestValues')`, holding a `Map` from the accessor's
token to the memoized value. Consequences:

- **`Symbol.for`, not `Symbol()`.** In dev the Vite module runner and Node hold
  two copies of a module; a module-local symbol would give a guard and its
  handler two "shared" values, and the failure mode is *the guard and the
  handler saw different sessions*. Registry symbols make the slot one slot.
- **No `__SIGX_SERVERFN_SERVICES__`.** The store travels on the context, so
  there is nothing to look up globally and no WeakMap to key on a source object.
  `docs/seams.md:228-241` reserves that row for #399; if this design lands, the
  row is **released** rather than claimed — one fewer global, and the seams
  registry's "prefer a DI token / prefer no seam" rule is honored.
- **What a request is, per transport**, follows the store rather than a separate
  keying rule: endpoint wire = the ctx the endpoint built (`server/index.ts:618`,
  put in the scope at `:636`); in-process under an SSR scope = the one
  `{ request, locals }` the scope normalized; `fn.with({ context: request })` =
  its own per-call bag (pass `{ request, locals }` to share across explicit
  calls — documented); detached = per call.

### 2.5 Memoization semantics

- **The setup's return value is memoized, promise included.** An async setup
  memoizes the *promise*, so a guard and a handler racing on first touch share
  one in-flight decode. There is never a second code path.
- **A throwing setup does not memoize its rejection** beyond the current
  request's store — a rejected value stays rejected for that request (retrying
  a failed session decode within one request would be a footgun, not a feature).
- **Re-entrancy is an error.** A setup resolving itself throws "circular request
  value" rather than memoizing `undefined`.

### 2.6 Disposal is deferred from v1 — deliberately

Requirement 4 is where every hard part lives, and F-A means it cannot be
delivered honestly yet:

- On WinterCG, `createFetchHandler` returns the `Response` from inside the scope
  (`fetch-handler.ts:163`), so "disposed when the response has fully flushed"
  would fire **at the shell**, mid-stream, on every edge deploy. A `useTrace`
  span that closes before the body finishes does not measure the request; it
  reports a wrong number confidently. That is worse than not having disposal.
- Making it true means extending the `__SIGX_SERVERFN_SCOPE__` contract with an
  optional `keepAlive(until: Promise<unknown>)` that the fetch handler calls with
  a promise resolved on body close/cancel/error, and the scope runner awaits
  before disposing. Absence of `keepAlive` stays a supported state, so an older
  `@sigx/server` beside a newer renderer still works.
- The endpoint side then hangs disposal off the **work promise's settle**, never
  the outer `timeoutMs` race (`server/index.ts:750-763`) — otherwise a 504 yanks
  resources out of a still-settling handler — and covers **four** stream
  terminal paths, not three (F-C).

**So: v1 memoizes and does not dispose.** `defineRequestValue` has no
`onDispose`. Disposal ships as its own phase, together with `keepAlive`, and
until it does, `rfc-server.md` §2.1's claim that around-middleware needs
(timing, tracing) "ride a request-scoped service whose `onDispose` fires when
the response has fully flushed" is **withdrawn** — an app that needs teardown
owns it in its own handler, where it already has the request.

When disposal does land, two rules from §2.2 carry over unchanged because they
are correct: disposers registered **synchronously, before the setup's first
`await`** (disposal does not block on a pending value), and `fn.with({ context })`
/ detached calls have no owner (GC only, with a `__DEV__` warning if a disposer
is registered on one).

### 2.7 The nested-scope merge (F-D, #495)

(B) makes F-D load-bearing: if an app pre-seeds `{ request, locals: { user } }`
and the renderer's inner scope replaces it with a bare request, the app's seed
vanishes *and* it silently gets a second store.

**Resolution: `runInScope` merges over an enclosing store instead of replacing
it** — when a scope is already open, the new source's fields win where supplied
and the enclosing `locals` object is carried through. The documented recipe then
means what it says, and one render has one store no matter how many times a
scope is opened around it.

The case it must not break is a genuinely different nested request (a worker
rendering a subrequest of itself). The merge therefore keys on the request: an
inner source whose request is a *different* URL/method opens a fresh store, and
`__DEV__` says so once. This ships as its own PR (#495) because it is a behavior
change to a shared primitive, not a new API.

### 2.8 What replaces "if a local wants a type, it wants to be a service"

That sentence (`rfc-server.md:558-560`) presumed (A). Its replacement:

> `rq.locals` stays `Record<string, unknown>` — it is the untyped face of the
> request store, for values a guard hands to a handler in one flow. When a value
> wants a **type**, it wants to be a **request value**: `defineRequestValue`
> gives it an accessor whose return type is inferred from its own setup, and the
> accessor is the only way to reach it, so there is nothing to cast.

The narrowing tRPC gets from builder-chain types is still not delivered — a
handler cannot statically know a guard already rejected `null`. The answer is
the same as §2.2's: a throwing accessor (`requireUser(rq): NonNullable<User>`),
paid once per app rather than once per handler. Declaration-merging on a
`ServerFnLocals` interface was considered and rejected: it types the bag without
guaranteeing anyone filled it, which is exactly the lie P3 describes.

### 2.9 Compatibility

Sharing `locals` across in-process calls in one flow is an **observable
change**: today a function writing `rq.locals.x` is writing into a bag nobody
else will ever read; afterwards its siblings in the same render see it. That is
the point, it matches what the wire path already does, and it is pre-1.0 —
recorded here rather than hedged around.

---

## §3 What this revision does not do

- **A process-level default `use` chain** *(#489)* — `configureServerFnDefaults`,
  or `createServerFnHandler({ use })` registering into one. It needs a
  `globalThis` seam (the dev dual module graph), and `docs/seams.md` requires a
  seam's miss to be a no-op, never a throw — on the auth path that is fail-open,
  the first seam in the registry whose absence is a security hole. It also makes
  a function's behavior depend on process state (a unit test and production
  disagree) and has an undetectable "invoked before registration" window. The
  chain belongs in the definition, where it is captured once and cannot be looked
  up too early.
- **A scope-carried guard chain** *(#489)* — the request scope is not an auth
  carrier: absent by design without `AsyncLocalStorage`, bypassed by
  `fn.with({ context })` and the detached context, and opened by
  `@sigx/server-renderer`, which cannot import this package, with the raw
  request. Three silent fail-open paths for one saved line.
- **Two service lifetimes, a captive-dependency rule, and an override seam**
  *(#399)* — see §2.2(A). Module scope is the process lifetime (§1.5); with one
  lifetime the captive-dependency bug cannot exist; a request value reached
  through a module mocks like a module.
- **An ambient no-argument accessor** *(#399)* — `useSession()` with no `rq`
  re-opens the ambient-at-the-call-site question the parent RFC settled for `rq`
  itself. Accessors take the context, like everything else here.
- **Disposal in v1** *(§2.6)* — deferred, with the reason and the shape it will
  take recorded.
- **Cross-module presets** — still deferred (a module-graph resolver inside
  per-file pure extractors, N.5, to delete one line per module).
- **Around-middleware, chainable builders, classes/controllers, an app-DI
  bridge, a `createContext` hook** — unchanged from the parent RFC's non-goals.
  Nothing here re-opens them.

---

## §4 Doc corrections (#493)

**These corrections ship with this RFC, not with a later phase** — the claim is
live in the published README and in the JSDoc an editor shows, and it describes a
security property. Corrected everywhere it is stated:
`packages/server/src/server/index.ts:34` (JSDoc), `packages/server/src/node.ts:12`
(the copy-paste example), `packages/vite/src/server-fn.ts:88-92` (the dev guard
option), `packages/server/README.md` ("Security defaults" and "The endpoint"),
and `rfc-server.md` §2 notes (`:315-319`), §4 (`:807-819`), §5 item 1
(`:998-1004`). Comment- and prose-only; no runtime change.

The name `guard` stays — renaming buys nothing once the contract is honest. The
corrected wording: *runs before every function reached through **this
endpoint** — the wire transports. It does not run for in-process (SSR-time)
calls, which never enter this handler; the transport-independent chain is the
definition's `use:` / `serverFnPreset`.* And §5's "there is no separate
middleware universe to forget" becomes true only **with** `requireGuards`
(§1.4); until then it is a claim about intent.

---

## §5 Phasing

Each phase is independently mergeable, and owes the tests named beside it.

1. **`serverFnPreset` (#398)** — the preset factory, `preset.stream`,
   direct-form guards, the `serverStream` in-process reroute (F-B),
   preset-seeded symbols, exported-preset warning, inline-form hard error, the
   spread-in-options guardrail.
   *Proves:* preset guards run on the **in-process** path and through
   `.with({ context })`; a multi-arg direct-form preset function survives a
   wire-shaped invoke (the F-B regression); a plain function's hashed symbol is
   **byte-identical** to today (pin a literal hash); editing the shared guard
   re-mints every derived hashed symbol and no stable symbol.
2. **`defineRequestValue` + the shared store (§2.3-2.5, #494)** — the scope
   normalizing its source once, the symbol slot, memoization.
   *Proves:* one value across many in-process calls in **one** render, and never
   across two concurrent renders; a guard and a handler racing on first touch
   share one in-flight promise; the same value on the wire path; no-ALS
   (workerd) degradation — explicit `rq` still works, nothing splits.
3. **The nested-scope merge (F-D, #495)** — its own PR, with the
   different-request escape hatch.
4. **`requireGuards` + `unauthenticated` (#489, §1.3-1.4)** — the extractor
   error channel and the `__sigxGuardChecked` stamp. (§4's doc corrections do
   not wait for this phase; they ship with the RFC.)
   *Proves:* a bare `serverFn` fails the build naming both remedies;
   preset-derived / `use` / `unauthenticated` all pass; the preset contradiction
   throws at definition time; `'warn'` warns without failing.
5. **Disposal + `keepAlive` (§2.6, F-A, F-C)** — only after the contract
   extension exists.
   *Proves:* disposal after a normal stream, an **empty** generator, a
   mid-stream throw, and a cancel; after a buffered JSON response, a form 303, a
   masked 500 and a guard veto; that a `timeoutMs` 504 does not dispose ahead of
   the settling handler; and — the one that motivated all of it — that a
   **streamed edge response** disposes at end-of-body, not at the shell.

One pin belongs to no phase and should land with the first: an explicit test
that the endpoint `guard` does **not** run for an in-process call, citing §1.1,
so the asymmetry is executable documentation and a future "fix" cannot change it
silently.

---

## Compatibility

Pre-1.0, no compat shims. Three observable changes, all recorded above:
`rq.locals` shared across in-process calls in one flow (§2.9), an SSR-time
`serverStream` now running its `use` chain (F-B — it ran none, which was the
bug), and `runInScope` merging rather than replacing an enclosing scope (§2.7).
Nothing on the wire changes: no envelope, no symbol, no stub, no endpoint
option removed.
