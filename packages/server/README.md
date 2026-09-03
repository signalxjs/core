# @sigx/server

Server functions (RPC) for SignalX — typed client↔server calls, extracted at
build time by `@sigx/vite/server`. The design RFC is
[`docs/rfc-server.md`](../../docs/rfc-server.md); the access model
(middleware / authentication / authorization, `createServerApp`) is
[`docs/rfc-server-v4.md`](../../docs/rfc-server-v4.md).

Not to be confused with `@sigx/server-renderer`, which renders documents —
this package is how your app **talks to** the server.

## The model

A server function lives in a `*.server.ts` module. The whole module is
server-only: it can import database clients, secrets, `node:` builtins —
none of it ships. The client build swaps the module for typed fetch stubs;
on the server the import is the real module, so a call is a direct
invocation. Same import, both sides, types flow through untouched.

```ts
// src/cart.server.ts
import { serverFn, requirePrincipal } from '@sigx/server';
import { db } from './db';

// productId/qty arrive from the wire — see "Validation and the two forms"
export const addToCart = serverFn(async (rq, productId: string, qty: number) => {
    const user = await requirePrincipal<User>(rq);   // resolved by the app's authenticate
    return db.cart.add(user.id, productId, qty);
});
```

No hand-rolled session check: the runtime is **fail-closed** — an anonymous
caller was already refused with a 401 before this body ran (see *The server
app* below), and `requirePrincipal` is only the typed accessor for the
identity the pipeline resolved.

```tsx
// any component — it's just an async function
import { useData, useAction } from 'sigx';
import { getCart, addToCart } from './cart.server';

const cart = useData(() => ['cart'], getCart, { cache: { staleTime: 30_000 } });
const add  = useAction(addToCart,   { cache: { invalidates: [['cart']] } });
```

Because a wrapped function is a plain async function, `useData`/`useAction`
and the whole `@sigx/cache` pack (staleTime, `invalidate()`, optimistic
`mutate`) compose with zero integration code. And a resumed handler
(`@sigx/resume`) that imports a server function works as-is — the handler
chunk gets the stub, the page still ships ~1 KB of JS, and the first click
POSTs to the server.

### Inline form (co-location)

For one-offs where a separate file is ceremony, declare a `serverFn` at
**module scope** of any component file — the transform lifts it the same
way:

```tsx
// Search.tsx — co-located
import { component, useData } from 'sigx';
import { serverFn } from '@sigx/server';
import { searchIndex } from './search-index';   // server-only dep

const search = serverFn(async (rq, q: string) => searchIndex.query(q));

export const Search = component((ctx) => {
    const q = ctx.signal('');
    const results = useData(() => ['search', q.value], () => search(q.value));
    /* … */
});
```

The client build swaps the initializer for the fetch stub and strips
imports that were only used inside the body (`searchIndex` never loads in
the browser); the server keeps the body in place. One strict rule makes
this safe: an inline body may capture **imports and globals only** —
touching component scope, signals, props, or file-local bindings is a
compile-time error telling you to pass the value as an argument. Two
placement rules follow from it: `serverFn` must be a module-scope `const`
(never created inside a component), and resume files should keep importing
from `*.server.ts` modules instead (a module-scope const is not a legal
capture for extracted QRL handlers).

There is **no closure serialization** — data crosses the boundary only as
typed arguments (I consider Qwik's captured-value round-trip an injection
surface, not a convenience). Validate them: the options form takes a
[Standard Schema](https://standardschema.dev) validator that always runs
server-side, plus a per-function authorization requirement no transport can
skip:

```ts
export const quote = serverFn({
    input: QuoteInput,            // Zod/Valibot/ArkType — rejects with a 400
    // Runs AFTER validation, so op.input is the trusted resource; only the
    // literal `true` allows (strict, fail-closed). Replaces the app default.
    authorize: (principal, rq, op) => canQuote(principal, op.input),
    async handler(rq, input) {
        return priceQuote(await requirePrincipal(rq), input);
    }
});
```

### Validation and the two forms

The two authoring forms trade ceremony against enforcement, and the
asymmetry is deliberate — know which side of it you're on:

- **Direct form** — `serverFn(async (rq, id: string) => …)` — multi-argument,
  zero ceremony. The parameter types are **compile-time only**: a hostile
  client ignores them, wire arguments reach the body unvalidated, and the
  argument count is unenforced (the declared shape isn't knowable at
  runtime).
- **Options form** — `serverFn({ input, handler })` — exactly one input,
  validated by the Standard Schema on every transport, extra wire arguments
  rejected with a 400. The arity guard exists here precisely because the
  shape *is* declared. `input` is also the inference source for the input
  type: omit it and the type falls back to the handler's parameter
  annotation — with neither the input is undeclared, and the callable takes
  **no argument at all** (`fn()`, not `fn(undefined)`). That is a typing
  statement, not a guarantee: the wire can still carry an input, it just
  reaches the handler unvalidated, which is what the warning below is for.

My rule of thumb: a function whose body checks everything it uses (loads by
id and authorizes, like `addToCart` above) is fine in the direct form;
anything whose arguments shape a query, a write, or a price belongs in the
options form with an `input` schema. In dev, a function that receives wire
input it has no validator for logs a once-per-function warning — the
direct form always (its types are compile-time only), the options form
when `input` is omitted. Declaring `input` is what resolves both.
`serverStream` has an options form too, in two shapes: declaring `input`
selects the single-input shape — `serverFn`'s semantics exactly, validated
after the pipeline's prelude and before the first chunk on every transport
(a wire rejection is a buffered JSON 400, never a streamed byte) — while
omitting it keeps the multi-argument shape (`authorize` and `allowAnonymous`
only), where many arguments have no single-input schema and validation
belongs at the top of the generator (any Standard Schema validates
standalone).

### The server app — `createServerApp`

App-wide policy lives in **one user-owned value** (rfc-server-v4 §3): the
pipeline (middleware, authentication, the default authorization), the
endpoint posture, and the principal codec. Every transport runs it — a wire
POST and an in-process SSR call see the same middleware, the same
authenticator, the same policies.

```ts
// src/server-app.ts — the ONE place policy lives
import { createServerApp } from '@sigx/server/server';

export const app = createServerApp<User>({
    middleware: [requestId, rateLimit],        // always runs, every transport, in order
    authenticate: async (rq) =>                // → User | null; null is anonymous
        decodeSession(rq.request.headers.get('cookie')),
    // authorize: the app DEFAULT policy — omitted, it is requireAuthenticated
    timeoutMs: 10_000,                         // endpoint posture, stated once
});
```

The pipeline order is pinned: **middleware → authenticate → the identity
gate → arity → `input` validation → `authorize` → handler**. Authentication
is memoized once per request store, so one SSR render with five cells
decodes the session once. Middleware is **not**: the chain runs once per
operation — every wire call, every stream open, every in-process call — so
that same render runs each middleware five times. Once-per-request work
(a request id, an audit record) goes in a `perRequest` value the middleware
touches, not in the middleware body (#628). On the wire the first three run
**before** the codec ever touches attacker bytes — an anonymous caller never
reaches the revive step or your validator.

Wire it up once:

- **Dev** — `sigxServer({ serverApp: '/src/server-app.ts' })`: the plugin
  loads the module eagerly through the SSR module runner and re-evaluates it
  after edits, so pipeline changes apply without a restart.
- **Prod** — the build injects one side-effect import of the module at the
  top of `virtual:sigx-server-fns`, so any entry importing the registry
  evaluates it before serving. A hand-wired entry just imports the module
  itself. Either way this is hardening, not a dependency: an un-imported
  server-app module **denies** (fail-closed), it never opens.

What the app hands back:

- **`app.serverFns(mount)`** — the endpoint handler for one mount
  (`{ resolve, base?, renderBoundaries?, authorizeBoundary?, …posture }`),
  inheriting the app's posture with per-mount overrides winning. Each mount
  claims its `base` namespace; overlapping prefixes throw at mount time
  (everything after the base IS the symbol). Routing still lives in your
  entry — `matchesServerFn` stays a predicate.
- **Posture inheritance everywhere** — a bare `handleServerFnRequest` call
  inherits the app posture too (`origin`, `maxBodyBytes`, `maxUrlBytes`,
  `maxResponseBytes`, `timeoutMs`, `onError`), with any explicit value
  winning, `origin: false` included.
- **`codec`** — `{ encode(principal): string, decode(string): principal | null }`,
  the cross-hop propagation contract packs like `@sigx/actors` consume.
- **`dispose()`** — releases the process seam (test teardown); a superseded
  app's dispose never tears down its replacement. Stamping is last-wins, so
  dev HMR re-evaluation is safe.

Per-function requirements stay in the definition: `authorize:` **replaces**
the app default for that function (most-specific-wins; arrays AND), and the
identity gate is the un-replaceable floor. Middleware is deliberately
app-only — never per-function-attachable or -disableable, which is exactly
what makes a rate limiter belong there (below). A module-scope shared policy
is one imported identifier per function (`authorize: adminOnly`).

### The access gate — `requireAuthorization` and `allowAnonymous`

The runtime is fail-closed — a function that declares nothing **denies**
anonymous callers on every transport — so the build gate's job is catching
the availability mistake, not the security one: "forgot `allowAnonymous` on
the sign-in endpoint" should be a build error, not a production lockout.
**On by default:**

```js
// vite.config.js — nothing to write; this is the default
sigxServer()

sigxServer({ requireAuthorization: 'warn' })    // migration rung: list, don't fail
sigxServer({ requireAuthorization: false })     // opt OUT, deliberately
```

Every extracted `serverFn` **and `serverStream`** — streams are public
endpoints too — must have a *decided* access policy: declare `authorize:`,
inherit the app default (a configured `serverApp` counts), or say so:

```ts
export const submitPat = serverFn({
    allowAnonymous: true,     // deliberate: this IS the sign-in
    form: true,
    input: PatSchema,
    handler: async (rq, pat) => …
});
```

A bare `serverFn(async (rq) => …)` with no `serverApp` configured is a build
error naming every remedy, with its file and line. `allowAnonymous` is a
word rather than an omission because "I meant this to be open" and "I
forgot" must not look identical — and it makes the open surface greppable:
`grep -rn allowAnonymous --include='*.server.ts' src/` prints every
anonymous-reachable endpoint, which is a list a security review can read.
Unlike the old `unguarded`, the word waives **only the identity gate**:
middleware and authentication still run (a signed-in caller still resolves a
principal, so rate limiting stays per-user and audit logs stay attributed),
and any declared `authorize` policies still run, receiving a nullable
principal.

Two limits, stated rather than implied:

- **It checks declaration, not correctness.** `authorize: [() => true]`
  passes. What it buys is converting "silently undecided" into a list a
  human wrote.
- **A module outside `include`/`scan` is never analyzed** — and no longer
  needs to be caught: an unanalyzed function **denies at runtime** instead
  of running open. The gap the old stamp machinery mitigated is closed by
  the fail-closed runtime, so the machinery is gone.

### Server-declared invalidation

A mutation declares which cache keys it invalidates **where the data
changed**, so the declaration cannot drift from the mutation — the keys
ride the response envelope (`$cache.invalidates`) and `@sigx/cache` feeds
them to `invalidate()` on arrival, with zero wiring:

```ts
export const addToCart = serverFn({
    input: AddInput,
    async handler(rq, input) {
        return db.cart.add(input);
    },
    // Runs after the handler, on the VALIDATED input + the result.
    invalidates: (input, result) => [['cart', input.cartId], ['totals']]
});
```

Client-side `cache.invalidates` on `useAction` still works; the
server-declared form is the better default for server-owned data.
(Declare it after `handler` in the literal — TypeScript infers `result`
in textual order.)

A pattern reaches **every** mounted `useData` read whose canonical key
matches — a `cache` option is not required, and neither is the cache pack
(#484). It also drops the matching keys from the SSR transfer blob, so
navigating away and back refetches rather than restoring the pre-mutation
value. Patterns are exact keys or tuple prefixes: `['cart']` matches
`useData(() => ['cart', id], fetchCart)`, and a bare function reference matches every
read of that server function.

### Single-flight boundary refresh

A mutation can also carry **fresh UI** back in the same response
(rfc-server §6.3) — driven by the SAME `invalidates` declaration, no
component names anywhere. During SSR each boundary records which `useData`
keys it read (`record.deps`); the client sends those up with the call, and
the endpoint re-renders every boundary whose deps intersect the mutation's
`invalidates` patterns through its `renderBoundaries` option (built by
`createBoundaryRefresh` from `@sigx/resume/server`). The envelope's
`$boundaries` entries patch never-hydrated resume boundaries **without
their component chunk ever loading** — upgraded ones get live-signal
writes instead:

```ts
export const getTracker = serverFn(async () => db.tracker());

export const track = serverFn({
    input: TrackInput,
    async handler(rq, input) {
        return db.track(input);
    },
    invalidates: () => [getTracker]   // fn refs, strings, or tuple prefixes
});

// Tracker.tsx — reading the data IS the subscription:
const tracker = useData(getTracker);

// in the deploy entry:
handleServerFnRequest(request, { resolve, renderBoundaries, authorizeBoundary });
```

Admission uses the cache pack's `keyMatches` semantics (exact string, or
canonical tuple prefix — a bare `[getTracker]` pattern matches
`useData(getTracker)` and every `useData(() => [getTracker, ...args])`
read). Everything is best-effort by design: a boundary that cannot be
re-rendered (or a renderer failure) is simply omitted and the UI converges
through `$cache` invalidation — the same declaration is that fallback.
Wire-only, like the `$cache` sidecar; meaningless with `cache`.

A refresh re-renders server components with **client-supplied props**, under
only the mutation's authorization — which is why the optional
`authorizeBoundary(rq, boundary)` hook exists (rfc-server-v4 §3.1): it runs
per admitted descriptor, after the deps gate, under the request's principal
(`principal(rq)`). Strict-`true` like every policy; a deny drops that one
descriptor silently (the client converges through `$cache` a round trip
later), a throw drops the whole refresh — the mutation is never affected.

### Zero-JS form actions — `form: true`

The mutation-side twin of `cache` (rfc-server §6.4): declaring `form: true`
marks a function as a **form target**. The endpoint then accepts native form
POSTs (`application/x-www-form-urlencoded` / `multipart/form-data`) for it,
and — when a resume `<form>`'s submit handler calls it — the build stamps a
real `action="/_sigx/fn/<symbol>" method="post"` onto the form:

```ts
export const submitFeedback = serverFn({
    form: true,
    input: FeedbackSchema,          // REQUIRED for form targets — see below
    handler: async (rq, input) => save(input)
});
```

- **JS loaded**: the resume delegation cancels the native submit and the
  handler runs as plain RPC — nothing changes.
- **JS off, failed, or not yet loaded**: the browser POSTs the form
  natively; FormData is normalized to the fn's single input (flat object,
  repeated names → array, `File` passed through, values stay strings —
  use Standard Schema coercion like `z.coerce.number()`), the same
  validator and handler run, and the response is a `303` back to the
  submitting page (handler-set `Location` wins; the Referer is
  same-origin-validated). Validation failures render a minimal HTML page —
  use native attributes (`required`, `type=`, `pattern=`) as the no-JS
  first line.
- **Security**: the JSON-content-type CSRF layer is deliberately given up
  for declared form targets only; the `Origin` check stays at full
  strength (an Origin-less form POST is 403 under every policy short of
  `origin: false` — even `'verify-when-present'`, whose relaxation is
  JSON-only, #556).
  Only mark genuinely intended form targets. `form: true` **requires**
  `input` — a definition-time error without it, in dev and prod alike,
  because form fields are attacker-typable strings and the validator is
  the only thing between them and the handler (a deliberately raw target
  declares an explicit pass-through schema; the error message shows it).
- `form` and `cache` are mutually exclusive, and declaring both is a
  definition-time error too (#567): a form target is a mutation, and the two
  program opposite transports — `cache` makes the stub GET with the arguments
  in the URL, a form POSTs fields.
- JSON callers of the same fn are untouched — same envelope, same errors.

### Cacheable reads — GET + `Cache-Control`

The read-side twin of `invalidates` (rfc-server §4.1): declaring `cache`
marks a function as a **side-effect-free idempotent read**. The stub then
calls it with `GET {endpoint}/{symbol}?a0=…` and the endpoint emits
`Cache-Control` from the declaration — the browser and any edge cache can
absorb repeats without touching the origin:

```ts
export const getProduct = serverFn({
    input: ProductQuery,
    cache: { maxAge: 60, staleWhileRevalidate: 300 },
    handler: async (rq, { id }) => db.products.get(id)
});
```

- Default is `private, max-age=…` **plus `Vary: Cookie`** — safe for
  personalized reads. `public: true` (+ `sMaxAge`) opts into shared/CDN
  caching under a strict contract: the output depends **only on the
  arguments**, never cookies, auth, or request headers (`__DEV__` warns
  when a public read touches `rq.request`).
- **Declaring `cache` is a promise.** A mutating function marked `cache`
  re-opens CSRF — GET has no content-type gate and no preflight. Only mark
  genuinely side-effect-free reads; `cache` and `invalidates` are mutually
  exclusive, and declaring both is a **definition-time error** (in production
  too, #567): the endpoint would drop the `invalidates` declaration on the GET
  path, telling no client cache and never running §6.3 boundary refresh — a
  silence you would only notice as stale data.
- Every non-2xx GET is `no-store`; a handler-set `cache-control` (via
  `rq.responseHeaders`) wins for dynamic per-input TTLs. POST stays valid
  for every function.
- Layering with `@sigx/cache`: `staleTime` decides *when* to refetch,
  `max-age` decides whether the refetch reaches the origin. For private
  reads keep `maxAge ≤ staleTime`; for public reads put the real budget in
  `sMaxAge` and keep the browser `max-age` short.

**The read URL is meant to be read.** A scalar argument rides as a named
param, so a cache key you can recognize in a network tab or a CDN log:

```
GET /_sigx/fn/getProduct_fn_9f3a01cc?a0=sku-42
```

Types survive because the grammar is lopsided: a param comes back as a
number, `true`, `false` or `null` only when its raw text says so, and the
one case that needs help is a *string* that would be misread that way — it
is JSON-quoted (`?a0="42"` → the string `"42"`). `007` and `+1` are not
numbers by this grammar, so they stay the strings they almost certainly
were. An argument richer than a scalar — an object, `Date`, `Map`, `Set`,
`BigInt` — falls back to the encoded `?args=` blob for the whole call, so
one request never mixes the two and the cache key stays a pure function of
the arguments. Mixing them explicitly, or leaving a gap in the `a0, a1, …`
sequence, is a 400 rather than a call with quietly shifted arguments.

### Streaming (`serverStream`)

An async generator wrapped in `serverStream` streams its yields to the
client as NDJSON; the stub is an `AsyncIterable`, and a **string-yielding**
stream plugs straight into `useStream` — progressive text with no new
client concept:

```ts
// src/ai.server.ts
export const explain = serverStream(async function* (rq, id: string) {
    for await (const token of llm.explain(id)) yield token;
});
```

```tsx
const text = useStream(`explain:${id}`, () => explain(id));
// <p>{text.value}</p>
```

The request starts lazily on first iteration; consumer `break`/`return()`
aborts the fetch and the server generator's `finally` runs (`rq.abortSignal`
fires on disconnect too). Errors travel in-band: a mid-stream throw ends
iteration with the branded wire error (masked in prod unless it's a
`ServerFnError`). One caveat vs `serverFn`'s buffered JSON: response
headers and status freeze at the **first yield** — set them before it.

A stream whose argument shapes a query belongs in the single-input options
form (#572) — `serverFn`'s `input` semantics exactly:

```ts
export const explain = serverStream({
    input: ExplainKey,        // Standard Schema — Zod/Valibot/ArkType
    handler: async function* (rq, key) {
        // `key` is the VALIDATED value
        for await (const token of llm.explain(key)) yield token;
    }
});
```

Validation runs after the pipeline's prelude and **before the first
chunk**, on every transport: over the wire a rejection is a buffered JSON
`400 { issues }` — headers still writable, no stream byte sent — and
in-process it rejects on the first pull, exactly where a middleware or
policy veto does. With `input` declared the stream takes one argument
(extras are a 400). Multi-argument streams keep the
`authorize`/`allowAnonymous`-only options form and validate at the top of
the generator.

A stream carries the same `.with()` per-call channel as a `serverFn`
(minus `fresh` — a stream is never HTTP-cached), so an SSR-time stream can
be handed the real request and a client stream can add one-off headers:

```ts
// SSR-time: the generator's rq.request/rq.url are the page's request
for await (const token of explain.with({ context: ssrRequest })(id)) { … }

// Client: one-off headers, and a caller signal on top of the consumer's
// own break/return abort
for await (const token of explain.with({ headers: { 'x-trace-id': traceId } })(id)) { … }
```

## Context

Every server function receives the request context as its **first
parameter** — no `this`, no ambient globals:

```ts
serverFn(async (rq, ...args) => {
    rq.request;          // WinterCG Request (headers, cookies via headers)
    rq.url;              // parsed URL
    rq.abortSignal;      // fires on client disconnect (never a reactive signal)
    rq.responseHeaders;  // mutable response headers
    rq.status(201);      // success status override
    rq.locals;           // middleware/policy hand-off — ONE bag per request (see below)
});
```

### In-process (SSR-time) calls

Calling a server function during SSR runs the same pipeline with no network
hop. By default the context is **detached**: `rq.request`/`rq.url` throw a
descriptive error, because there is no HTTP request to expose. That matters
for the most common shape there is —

```ts
const user = await sessionFrom(rq.request);   // fine over RPC, throws during SSR
```

Two ways to supply the request, most explicit first:

```ts
// 1. Per call — works on every runtime, no ALS needed.
await getCart.with({ context: request })(cartId);

// 2. Ambient — every server function called anywhere inside sees it.
import { runWithServerFnContext } from '@sigx/server/node';

await runWithServerFnContext(request, () => renderHandler(req, res, next));
```

Form 2 is usually already done for you: `createRequestHandler` and
`createFetchHandler` open a scope around every render, so an app that mounts
either handler — and imports `@sigx/server/server` or `@sigx/server/node` for
its endpoint, as every app with server functions does — has ambient context
with no wiring at all. Call `runWithServerFnContext` yourself for renders sigx
does not own, or to supply a request with your own abort wiring.

Nesting **merges** rather than replacing: wrapping a render that opens its own
scope is the point of form 2, so
`runWithServerFnContext({ request, locals: { user } }, () => renderHandler(…))`
is carried through — the inner scope's fields win where supplied, and the
enclosing `locals` stays the request store. "Same request" means same URL +
method (protocol excluded, so a TLS-terminating proxy does not split it);
anything else gets its own store and a once-per-process dev notice naming both.
Two ways to be deliberate: pre-seed with `{ locals }` and no request — it makes
no claim about which request it is, so it always merges — or hand a nested
render its own `locals` to isolate it on purpose.

`runWithServerFnContext` uses `AsyncLocalStorage`, so the request survives
every `await` in the render without threading a parameter through user code.
It needs Node, Deno, or workerd with `nodejs_compat`; where it is missing the
render runs unscoped rather than failing, and form 1 behaves identically. `.with({ context })` wins over ambient, and
with neither the throw stays — a function reading `rq.request` when nothing
supplied one is a bug worth seeing, not a silent `undefined`.

`context` accepts a `Request` or a partial `ServerFnContext` (to set `locals`,
say). Passing `{ request, locals }` — the **same object** on each call — shares
one request store across explicit calls; a fresh `Request` per call is its own
store, which is how a test isolates two calls with no framework ceremony
(`createTestServerFnContext()` below builds those objects ready-made). A supplied `Request` also supplies `rq.abortSignal`, so wire its signal
to the client disconnect (`res.once('close', …)` under Node) and SSR-time work
stops when the client goes away. `rq.responseHeaders`/`rq.status()` stay inert
either way: there is no
HTTP response to affect, and pretending otherwise would silently drop headers.
On the client `.with({ context })` is ignored, with a dev warning — a stub's
context is the request it makes.

### Per-request values — `perRequest`

Work derived from the request — a decoded session, an authenticated API
client, a request id — should be computed **once per request**, no matter how
many functions in that flow need it. It isn't, by default: every call used to
get a fresh `rq.locals`, so a page with five SSR-enabled cells decoded the same
session five times (cookie parse → verify → database read → decrypt, each
time).

A scope now carries one store for the whole request, and `perRequest` is its
typed face:

```ts
// src/session.server.ts
import { perRequest, ServerFnError } from '@sigx/server';

export const session = perRequest(async (rq) =>
    decodeSession(rq.request.headers.get('cookie')));

export const github = perRequest(async (rq) => {
    const s = await session(rq);          // the SAME memoized promise
    if (!s) throw new ServerFnError(401, 'Sign in');
    return createGitHubClient(s.token);
});

// src/server-app.ts — the session IS the authenticator: same memo, same
// store, and the identity gate 401s anonymous callers app-wide.
export const app = createServerApp({ authenticate: (rq) => session(rq) });

// src/board.server.ts — nothing to repeat: the app default protects it.
export const boardIssues = serverFn({
    input: BoardKey,
    handler: async (rq, key) => (await github(rq)).issues(key),   // no decode, no cast
});
```

The accessor takes `rq` — no ambient lookup at the call site, the same rule
`rq` itself follows. Values **compose by calling each other**; there is no
composition API.

- **The value is memoized, promise included.** An async setup memoizes the
  *promise*, so a middleware and a handler racing on first touch share one in-flight
  decode. There is never a second code path.
- **A failed setup stays failed for that request.** Retrying a failed session
  decode once per cell would be a footgun, not a feature.
- **A setup that resolves itself throws** "circular request value" rather than
  memoizing `undefined`.
- **The store follows the request**, per transport: the endpoint's context on
  the wire, the one the scope normalized in-process, the object you handed
  `.with({ context })`, and per call when nothing supplied either. Without
  `AsyncLocalStorage` (workerd with no `nodejs_compat`) there is no scope to
  share, so a value is computed per invocation — the pipeline and handler of one
  call still share it, exactly as before this existed.
- **Teardown rides `onDispose`** (rfc-server-v3 §2.6, #571) — the setup's
  second parameter:

  ```ts
  export const db = perRequest((rq, onDispose) => {
      const conn = pool.acquire();
      onDispose(() => conn.release());   // register SYNCHRONOUSLY, before any await
      return conn;
  });
  ```

  Disposers run **when the response has fully flushed** — streamed edge
  bodies included: the fetch handler extends the scope's disposal to
  end-of-body via the `keepAlive` seam, so a `useData` fetcher settling
  mid-stream never sees its own teardown. They run LIFO, each awaited,
  throws logged and swallowed; a `timeoutMs` 504 does **not** dispose ahead
  of the still-settling handler, and a stream's generator `finally` always
  completes first. Registration after the setup's first `await` still
  registers, with a dev warning. The store's owner is whoever opened the
  request — the endpoint or the render scope; a context you hand to
  `fn.with({ context })` (and a detached call) has **no owner**: nothing
  runs its disposers automatically (dev-warned), and
  `disposeRequestValues(rq)` — exported from the root — is your trigger
  when that request is over. On Cloudflare, heavyweight disposers may need
  your entry's `ctx.waitUntil` — the platform can cancel work after the
  last body byte. Upgrade `@sigx/server` and `@sigx/server-renderer`
  together for streamed-edge disposal: an older renderer never calls
  `keepAlive`, so on that pairing a streamed body's disposers fire at the
  shell instead.

`rq.locals` is the other face of the same store — the **escape hatch**, for a
value too small or too transient to name, and the reason a middleware can still
write `rq.locals.x` and have the handler read it. Reach for a per-request value
first: it types itself from its own setup, and the accessor is the only way to
get at it, so there is nothing to cast.

### Testing — `@sigx/server/testing`

Three helpers close the gaps unit tests hit; everything else already
exists as public surface (#570, rfc-server-v4 §2.4):

```ts
import {
    createTestServerFnContext,
    stubServerApp,
    stampServerFnKey
} from '@sigx/server/testing';

// A real, Request-backed context — rq.request/rq.url never throw, and
// rq.status(code) RECORDS instead of warning. The `principal` option seeds
// the identity memo, so the app's authenticate never runs — you test the
// handler under an identity, not through the cookie parser:
const anon  = createTestServerFnContext(undefined, { principal: null });
const alice = createTestServerFnContext(undefined, { principal: { id: 'alice' } });

// The pipeline needs NO new invoker — fn.with({ context }) runs the whole
// in-process pipeline: middleware, authentication, the identity gate,
// arity gate, input schema, authorize.
await expect(secret.with({ context: anon })()).rejects.toMatchObject({ status: 401 });
await expect(secret.with({ context: alice })()).resolves.toBe('data');

// Integration-shaped tests stamp an app config and restore it after:
const restore = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
try { /* … */ } finally { restore(); }

// Assert what the handler did to the response:
alice.statusCode;                  // the last rq.status(code), or undefined
alice.responseHeaders.get('set-cookie');
```

Isolation is the store-identity rule above, ready-made: one factory context
across several `fn.with({ context: ctx })` calls is **one** request
(`perRequest` values shared, authentication memoized once); two factory
calls are two requests. Wire-path behavior (the pipeline's wire half,
codecs, form parsing, status codes) is tested the way this repo tests it —
hand a `Request` to `handleServerFnRequest` with a `resolve` that returns
your function.

`stampServerFnKey(fn, key?)` mints the build stamp `useData(fn)` requires
(`__sigxKey`, defaulting to `test/<name>`) on the SAME function — identity
is load-bearing, so it mutates rather than wraps. Without it, `useData(fn)`
dev-throws in unit tests because the key is stamped by the Vite transform,
which a test run does not have. Streams are rejected: a stream is not a
`useData` target.

The helpers are test-*oriented*, not dev-only — they behave identically
against the prod dists (only the defensive throws strip), so a test run
against production bundles does not change context semantics.

## The endpoint

`POST /_sigx/fn/<symbol>` with `{"args": [...]}` → `{"data": ...}` or
`{"error": {message, status, data?}}`. Symbols are content-hashed, so a
stale client gets a typed version-skew error, never a silent wrong call.

Dev needs no wiring — the `sigxServer()` Vite plugin serves the endpoint
from `vite.middlewares`. Production mounts the handler beside the document
handler, fed by the build's registry chunk:

```js
import { createServerFnHandler } from '@sigx/server/node';

// Importing the registry also evaluates your server-app module (the build
// injected the import), so the pipeline is stamped before the first request.
const { serverFns } = await import('./dist/server/sigx-server-fns.js');
app.use(createServerFnHandler({ functions: serverFns }));
app.use(createRequestHandler({ /* documents, unchanged */ }));
```

There is no per-handler auth hook: app-wide policy — middleware,
authentication, the default authorization — lives in `createServerApp` and
runs identically for requests this handler serves and for the in-process
calls the document handler beside it makes while rendering
(rfc-server-v4 §3).

On WinterCG runtimes (Cloudflare, Deno, Bun) skip the adapter —
`handleServerFnRequest(request, options)` from `@sigx/server/server` is
already fetch-handler-shaped. Route with its sibling predicate:

```js
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';

if (matchesServerFn(request)) return handleServerFnRequest(request, opts);
return renderDocument(request);   // your document handler
```

(`matchesServerFn(request, base?)` matches the pathname under the mount
path — deliberately a predicate, not a combinator; composition stays in
your entry.)

**If you moved the mount, say so in one place.** `sigxServer({ base })`,
`matchesServerFn(request, base)` and the handler's own `base` must agree, and
they default independently — a disagreement is a silent 404, and since #543
`base` is load-bearing for symbol extraction (everything after it *is* the
symbol), so a base that is wrong only in part slices the symbol at the wrong
offset instead of missing cleanly. The build exports what it baked, so nothing
has to be repeated:

```js
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';

if (matchesServerFn(request, serverFnBase)) {
    return handleServerFnRequest(request, {
        base: serverFnBase,
        resolve: (symbol) => serverFns[symbol]?.() ?? null
    });
}
```

A non-default `base` whose entry still calls `matchesServerFn(request)` is a
build-time warning, and a request that reaches a handler its base does not
describe is a `__DEV__` warning beside the 404.

### Size caps — `maxBodyBytes`, `maxUrlBytes`, and `maxResponseBytes`

```js
createServerFnHandler({
    functions: serverFns,
    maxBodyBytes: 1_048_576,   // default 1 MiB — enforced WHILE reading; 413 over it
    maxUrlBytes: 8_192,        // default 8 KiB — a GET read's query string; 414 over it
    maxResponseBytes: 5_242_880 // OUTBOUND cap — default unlimited (opt-in)
});
```

`maxUrlBytes` is the request-line analog of `maxBodyBytes` and applies to
cache-marked GET reads (§4.1), whose arguments ride the query string. The 8 KiB
default sits under mainstream proxies' request-line limits, so the endpoint
answers `414` before a proxy answers it for you with something less
diagnosable. The client stub independently warns in `__DEV__` above ~2 KiB of
arguments — arguments that large make a poor cache key, which is the real signal
to drop `cache` and let the read POST.

`maxResponseBytes` (#571) is the outbound analog — the ceiling a fn that
returns an unbounded result (an unfiltered query, a runaway generator)
otherwise doesn't have. It measures actual UTF-8 bytes, and what happens
over it depends on where the bytes were going:

| Over the cap | The caller sees |
|---|---|
| buffered envelope (POST or GET read) | masked 500 — a server fault, surfaced to `onError` |
| `ServerFnError.data` | the error intact, `data` dropped (dev-warned; `onError` NOT fired — the fn's own throw is still the story) |
| stream chunks (cumulative) | first chunk: buffered 500; later: the in-band `{"error"}` line, generator disposed, `onError` fired |
| form 303 | nothing — no body to cap |

Default unlimited, deliberately: this is operator hygiene (memory, egress),
not an attacker-facing defense, and an imposed default would break existing
large reads.

`handleServerFnRequest` (WinterCG) enforces all three directly. The two layers
that WRAP it — `createServerFnHandler` (Node) and the `sigxServer()` dev
middleware, which goes through that adapter — each hand-listed the options they
passed down, and each silently dropped `maxUrlBytes` that way: #545/#547 at the
adapter, #561 at the dev middleware. Both now derive their option type from
`ServerFnRequestOptions` and forward by spread, so an option added to the
endpoint reaches every mount without being copied anywhere.

### Operations: `onError` and `timeoutMs`

Two opt-in endpoint options harden a real deployment (both flow through the
node adapter unchanged):

```js
app.use(createServerFnHandler({
    functions: serverFns,
    // EVERY masked failure — any non-ServerFnError throw, timeouts
    // included — in dev AND prod, before the response. Awaited; its own
    // throws never affect the response. Wire it to Sentry/OTel/logs.
    onError: (error, info) => log.error({ fn: info.name, error }),
    // Upper bound on pipeline + handler (+ a stream's first chunk). On
    // expiry: 504 to the caller, rq.abortSignal fires, onError sees the
    // timeout. A STARTED stream is not bounded (time-to-first-byte only).
    timeoutMs: 10_000
}));
```

`ServerFnError`s are expected, client-visible errors — they do not fire
`onError`. Prod masking is unchanged: the caller still sees a generic 500.

### Rate limiting — middleware, not an option

There is deliberately no `rateLimit` endpoint option, and there will not be
one: anything mounted only at the endpoint is **wire-only by construction**
(an in-process SSR call never enters the handler), which is the exact
transport asymmetry the app pipeline exists to correct. A rate limiter **is
middleware** — app-wide, never per-function-disableable, which is the point:
`allowAnonymous` cannot switch it off.

```ts
// src/server-app.ts — a token bucket per principal, in module state
import { createServerApp } from '@sigx/server/server';
import { principal, ServerFnError, type ServerMiddleware } from '@sigx/server';

const buckets = new Map<string, { tokens: number; at: number }>();

const rateLimit: ServerMiddleware = async (rq, fn) => {
    if (fn.transport !== 'wire') return;   // never throttle your own renders
    const user = await principal<User>(rq);            // memoized; null = anonymous
    const key = `${user?.id ?? 'anon'}:${fn.symbol}`;  // per-user, per-function
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: 10, at: now };
    b.tokens = Math.min(10, b.tokens + ((now - b.at) / 1000) * 2);  // 2/s, burst 10
    b.at = now;
    if (b.tokens < 1) throw new ServerFnError(429, 'Too many requests');
    b.tokens -= 1;
    buckets.set(key, b);
};

export const app = createServerApp<User>({
    middleware: [rateLimit],
    authenticate: sessionFromCookie,
});
```

The pieces that make this correct:

- **`fn.transport` is the transport discriminator** — a documented contract,
  not a trick (`'wire'` for the four HTTP transports, `'in-process'` for
  SSR-time and direct calls; it replaced the old `symbol === ''`
  convention). Middleware runs on EVERY transport (that is its point), so
  the wire-only decision belongs *inside* the body. Without that line, one
  SSR page rendering five cells burns five tokens of its own budget.
  Authentication and authorization must NOT carry this gate — access holds
  everywhere.
- **`principal(rq)` is memoized once per request**, so calling it here costs
  nothing extra — and middleware runs *before* the pipeline's own
  authenticate step only in the sense of ordering, not of duplication: the
  first touch resolves it, everyone after shares the memo. For
  unauthenticated surfaces, key off headers — read `rq.request` behind
  `try/catch`, because a detached in-process context throws there and
  fail-open is exactly right for renders.
- **Streams are covered for free** — middleware runs before the first pull
  on every transport, so admission-style limiting applies to `serverStream`
  unchanged. A *concurrency* cap (increment on admit, decrement on finish)
  releases through `perRequest`'s `onDispose` (#571): admit in a setup,
  register the decrement, and it fires when the response has fully flushed —
  streams included (see *Per-request values*). A generator's own `finally`
  still works where the cap lives entirely inside one handler.
- **Cost accounting**: middleware sees `(rq, fn)` but never the arguments
  (deliberate — on the wire it runs pre-validation, pre-decode). Charge by
  input weight in an `authorize` policy (which sees the VALIDATED
  `op.input`) or at the top of the handler, debiting a `perRequest` bucket
  the middleware admitted.

### Cancellation — `.with({ signal })`

Every `serverFn` callable carries a per-call options channel. Inside a
`useData`/`useAction` fetcher the async engine already hands you an
`AbortSignal` that fires when the query is superseded or unmounted — pass
it through and the fetch aborts, firing `rq.abortSignal` server-side:

```ts
const results = useData(
    ['search', q.value],
    (arg, ctx) => search.with({ signal: ctx.signal })(arg)
);
```

Explicit by design (no trailing-argument sniffing — the wire args stay
exactly your args); on an in-process (SSR) call the signal becomes
`rq.abortSignal` directly.

### Per-call `headers` and `fresh`

The same channel carries the rest of rfc-server v2's per-call options
(#315):

```ts
// One-off headers for THIS call — merged over configureServerFn's
// transport headers (the per-call value wins). content-type is never
// overridable, same as the transport rule.
await exportReport.with({ headers: { 'x-trace-id': traceId } })(reportId);

// Bypass HTTP caches for one call of a cache-marked GET read: the fetch
// runs with cache: 'no-cache', so the browser revalidates with the
// origin instead of answering from max-age.
const latest = await getProduct.with({ fresh: true })({ id });
```

Both are transport options: on an in-process (SSR-time) call there is no
HTTP request, so they are ignored with a `__DEV__` warning — the mirror
of `.with({ context })` being ignored on the client. `fresh` is likewise
a no-op on a POST call (POSTs are never HTTP-cached).

### `.with()` on a `serverStream`

A `serverStream` carries the same channel **minus `fresh`** — a stream is
always POST and can never be answered from an HTTP cache, so passing it is
a compile error rather than a dev-warned no-op:

```ts
// signal — composes WITH the consumer's own break/return abort, which
// still works on its own; the caller's signal is additional, never a
// replacement
for await (const token of explain.with({ signal: ctx.signal })(id)) { … }

// context — the SSR-time gap this closes: without it an in-process
// stream's rq.request/rq.url throw unless a runWithServerFnContext scope
// happens to be on the stack. Explicit beats ambient here too.
for await (const token of explain.with({ context: ssrRequest })(id)) { … }

// headers — one-off request headers for this stream's fetch, merged over
// configureServerFn's the same way
for await (const token of explain.with({ headers: { 'x-trace-id': t } })(id)) { … }
```

### What survives the wire

Rich types cross in **both** directions — arguments, results, stream chunks
and `ServerFnError.data` — with no configuration:

| Type | Round-trips |
|---|---|
| `Date` | ✅ a live `Date`, not an ISO string |
| `Map` / `Set` | ✅ |
| `BigInt` | ✅ (it used to throw) |
| `URL`, `RegExp` | ✅ |
| explicit `undefined` property | ✅ preserved, not dropped |
| plain objects, arrays, primitives | ✅ unchanged |
| **circular structures** | ❌ an error — the one shape that fails LOUDLY |
| class instances | ❌ arrive as plain objects, prototype gone (register a handler) |
| `Uint8Array` / typed arrays / `ArrayBuffer` | opt-in — register `bytesHandler` from `@sigx/serialize/bytes` (#569); unregistered they arrive as `{"0":…,"1":…}` |
| `Error` | ❌ arrives as `{}` — message and stack are not own enumerable props |
| `Promise` | ❌ arrives as `{}` (a missing `await`) |
| `NaN` / `±Infinity` | ❌ arrive as `null` |
| `WeakMap` / `WeakSet` | ❌ arrive as `{}` |

Everything in the second group is a **lossy success**: the call returns 200 and
the value looks like data. In dev the codec now warns once per call, naming the
property path (`result.items[0].thumb is Uint8Array — it encodes as a plain
object of indices`), and skips anything a registered handler claims — so an app
that taught it `Uint8Array` hears nothing. There is no type-level guard on a
server function's return type, deliberately: serializability is
runtime-configurable through that same handler registry, so a
`Serializable<R>` bound would reject exactly the apps that did the right thing,
and could not see a missing `await` or a cycle anyway.

```ts
export const getOrder = serverFn(async (rq, id: string) => ({
    id,
    createdAt: new Date(),          // arrives as a Date
    tags: new Set(['priority']),    // arrives as a Set
    total: 1999n                    // arrives as a BigInt
}));
```

Class instances lose their prototype unless a handler is registered for
them. Register custom types ONCE with the app-plugin face (#413, #411) —
one `types` array covers the RPC wire AND every other boundary (the SSR
state blob, boundary table, refresh, cache seed):

```ts
import { serverPlugin } from '@sigx/server/plugin';

app.use(serverPlugin({
    types: [{
        name: 'money', tag: '$money',
        test: (v) => v instanceof Money,
        serialize: (v) => v.cents,
        revive: (c) => new Money(c)
    }]
}));
```

App-less contexts (an endpoint-only process, a zero-JS loader page) use
`registerWireTypeHandlers(handlers)` from the same entry — it stamps the
`globalThis.__SIGX_SERVERFN_CODEC__` seam tag-keyed (the same global-seam
pattern `$cache` uses, so the stub entry stays dependency-free; stamping
the global directly still works).

Binary is the one rich type that ships ready-made rather than built in:
`bytesHandler` from `@sigx/serialize/bytes` (#569) round-trips `Uint8Array`
(and every typed-array kind, `DataView`, bare `ArrayBuffer`) as base64 —
add it to the same `types` array. Opt-in because the codec entry is
size-budgeted into every client bundle; files still arrive inbound via
`form: true` (a `File` reaches the handler), and with the handler
registered the return path carries bytes too.

The plugin also carries the stub transport (`configureServerFn`'s options,
app-scoped with teardown): `serverPlugin({ transport: { endpoint, headers,
fetch } })`. Transport installs on live clients only — the browser, or a
native client that called `declareLiveClient()`; a per-request server app's
install skips it (in-process calls never use the stub transport, and a
process-global write would bleed across requests).

Registered handlers are consulted **before** the built-ins, so a pack can own
a type they also cover. Encoded values take the form
`{ $date: 1700000000000 }` (epoch **milliseconds**, straight from
`Date#getTime()`);
a user object that happens to look like one (`{ $date: 'a string' }`) is
escaped and comes back intact, and an unrecognized tag is passed through
rather than throwing — so a client and server on different versions degrade
instead of breaking. See rfc-server §4.

## Native clients — transport config

A lynx or terminal app calling a remote sigx server — or a bearer-auth web
SPA — configures its stubs' transport once at startup (rfc-server rev 2):

```ts
import { configureServerFn } from '@sigx/server/client';

configureServerFn({
    endpoint: 'https://api.example.com/_sigx/fn',
    headers: () => ({ authorization: `Bearer ${token()}` })
});
```

Stubs resolve the transport at **call time**: one build serves
dev/staging/prod, header factories (sync or async) can rotate credentials,
and a custom `fetch` slots in where the platform provides its own.
`content-type` always merges last — the endpoint accepts nothing but JSON.
`configureServerFn(null)` restores the build-time target; with no config,
requests are byte-identical to v1.

Native clients authenticate with token headers (CSRF-immune by
construction) and never send `Origin` — serve them with
`origin: 'verify-when-present'` (below).

Server bodies must never execute in a live client: `declareLiveClient()`
(the platform-identity call lynx/terminal make) stamps a global marker,
and the real `serverFn` wrapper **throws** if invoked there — a build that
skipped the stub swap fails loudly, matching the browser condition's
posture.

A native-client build declares itself in the Vite plugin:
`sigxServer({ role: 'client', endpoint: 'https://api.example.com/_sigx/fn' })`
— every environment gets stubs and no registry is emitted (there is no
server in that build). Shared `*.server.ts` packages outside the app's
Vite root are discovered with `scan: ['../packages/api']`.

## Stable routes — backend deploys never break installed apps

Every function is registered under TWO symbols. The content-hashed one
(`addToCart_fn_9f3a01cc`) is what web builds fetch — version skew is a
typed 404 and a reload fixes it. The hash-free **stable symbol**
(`@acme/api/src/cart.server.ts/addToCart`) is what `role: 'client'` builds
fetch — an installed lynx app or terminal CLI cannot reload, so its routes
survive every backend redeploy. Symbol seeds are package-qualified, so
every app build of one solution mints identical symbols for a shared
server module.

Moving or renaming a server module changes its stable symbol — a breaking
API change for native clients, exactly like changing a REST route. Published
APIs pin an explicit id instead: `serverFn({ id: 'cart/add', handler })`
(string literal — the build reads it statically) keeps both routes stable
across file moves. Contract safety lives in the `input` validator (argument
changes surface as a 400 the client can show as "update the app"), and
semantic changes are explicit versioning — a new export or a new `id`.

A stable symbol's slashes are REAL path separators, so the route reads as
the id does and needs nothing special from your infrastructure:

```
POST /_sigx/fn/@acme/api/src/cart.server.ts/addToCart
POST /_sigx/fn/cart/add          # with id: 'cart/add'
```

Only a character a URL path genuinely cannot carry is percent-encoded, and
per segment. An id is normalized to fit: `..` segments become `_up` (a URL
would otherwise resolve them away and silently retarget the route), and an
explicit `id` that had to be rewritten warns at build time naming the route
it actually gets.

## Security defaults

Every server function is a public HTTP endpoint; the defaults assume that:

- **POST-only**, required `application/json` media type, and a same-origin
  `Origin` check (CSRF posture). `origin: 'verify-when-present'` verifies
  the header when present and admits header-less programmatic clients
  (native apps, CLIs, server-to-server) — browser CSRF stays independently
  blocked by the non-safelisted JSON content-type, and `Origin: null` is a
  present header and still rejected. The relaxation is JSON-only: it never
  applies to form-content-type POSTs, which give up that content-type
  layer (#556). Never deploy an Origin-stripping
  proxy in front of a cookie-authenticated app under that policy. An
  allowlist or `origin: false` makes it a deliberate public API.
- **Fail-closed access, on every transport** (rfc-server-v4). The app
  pipeline — middleware → authenticate → the identity gate — runs before
  the codec decodes attacker bytes on the wire, and identically for
  in-process (SSR-time) calls inside `invoke`; authorization runs after
  `input` validation, immediately before the handler. A function that
  declares nothing **denies anonymous callers with a 401**; only the
  literal `allowAnonymous: true` waives the gate, and even then middleware
  and authentication still run. There is no endpoint-mounted auth hook to
  forget — the one pipeline is the seam. The build's `requireAuthorization`
  check (on by default) is what makes "nobody left a function undecided" a
  build error rather than a runtime surprise.
- **`maxBodyBytes`** (1 MiB default) enforced while reading.
- **`maxUrlBytes`** (8 KiB default) caps a cache-marked GET read's query
  string — the URL analog of `maxBodyBytes`, answered with a 414.
- **Error masking**: only `ServerFnError` crosses the wire verbatim; other
  throws become a generic 500 in production.
- **Prototype-pollution keys dropped** from parsed values on both parse
  sites (a reviver removes `__proto__`/`constructor`/`prototype`; the
  request itself is not rejected). The reviver is skipped when the source
  text provably cannot spell one — no literal and no `\u` escape — which is
  a pure speed-up, not a relaxation: the parsed value is identical either
  way, escape-spelled keys included (#544).
- **Argument validation is opt-in** — the options form's `input` is the
  validation seam; direct-form arguments are not validated at runtime (a
  `__DEV__` warning fires once per function when one receives wire
  arguments). The exception is `form: true`, which requires `input` at
  definition time — the no-JS transport's validator is load-bearing.

## Entry points

| Entry | Runs on | What |
|---|---|---|
| `@sigx/server` | server (browser condition throws) | `serverFn`, `serverStream`, `perRequest`, `principal`, `requirePrincipal`, `setPrincipal`, `requireAuthenticated`, `ServerFnError`, `isServerFnError`, types |
| `@sigx/server/client` | any client (browser, lynx, terminal) | the generated stubs' runtime + `configureServerFn` (dependency-free) |
| `@sigx/server/server` | anywhere (WinterCG) | `createServerApp`, `handleServerFnRequest(request, options)`, `matchesServerFn` |
| `@sigx/server/node` | Node | `createServerFnHandler(options)` — connect-style |
| `@sigx/server/plugin` | app setup (any side) | `serverPlugin({ transport, types })` + `registerWireTypeHandlers` |
| `@sigx/server/testing` | tests (server-side) | `createTestServerFnContext`, `stubServerApp`, `stampServerFnKey` (#570) |

The runnable example is `examples/resume` (the "server function from a
resumed handler" card).

## A note on AsyncLocalStorage, if you are tuning a Node deployment

The ambient request scope (#309 — what lets an SSR-time `serverFn` call see
the real request) is an `AsyncLocalStorage`. On Node's default
implementation, the first `.run()` installs promise hooks **process-wide and
permanently**: from then on every `await` in the process pays for them, not
just the ones inside a scope. Measured here on Node 22, five awaits cost
367 ns before the first scope and 861 ns after.

`node --experimental-async-context-frame` switches `AsyncLocalStorage` to
async context frames and removes that: the same five awaits go back to 322 ns
outside a scope, and cost 637 ns instead of 887 ns inside one. Nothing in this
package needs the flag and nothing behaves differently with it — it is purely
how the runtime implements the storage. Check whether your Node version has
already made it the default before adding it, and measure your own workload;
the win is proportional to how many awaits per request your app does, not to
anything sigx controls.

Where `node:async_hooks` is unavailable altogether (workerd without
`nodejs_compat`), the scope degrades to running unscoped — a supported state,
not an error. `fn.with({ context })` works on every runtime and needs no ALS.
