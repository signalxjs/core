# @sigx/server

Server functions (RPC) for SignalX — typed client↔server calls, extracted at
build time by `@sigx/vite/server`. The design RFC is
[`docs/rfc-server.md`](../../docs/rfc-server.md).

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
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';
import { sessionFrom } from './auth';

export const addToCart = serverFn(async (rq, productId: string, qty: number) => {
    const user = await sessionFrom(rq.request);
    if (!user) throw new ServerFnError(401, 'sign in first');
    return db.cart.add(user.id, productId, qty);
});
```

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
server-side, plus a per-function middleware chain no transport can skip:

```ts
export const quote = serverFn({
    input: QuoteInput,            // Zod/Valibot/ArkType — rejects with a 400
    use: [requireAuth],           // runs on EVERY transport
    async handler(rq, input) {
        return priceQuote(rq.locals.user, input);
    }
});
```

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

### Single-flight boundary refresh

A mutation can also carry **fresh UI** back in the same response
(rfc-server §6.3): declare which boundary components it may refresh, wire
the endpoint's `renderBoundaries` option (built by `createBoundaryRefresh`
from `@sigx/resume/server`), and the envelope's `$boundaries` entries patch
never-hydrated resume boundaries **without their component chunk ever
loading** — upgraded ones get live-signal writes instead:

```ts
export const track = serverFn({
    input: TrackInput,
    async handler(rq, input) {
        return db.track(input);
    },
    refreshes: ['Tracker']            // component registry keys; or (input, result) => keys
});

// in the deploy entry:
handleServerFnRequest(request, { resolve, renderBoundaries });
```

The client stub sends the page's matching boundary descriptors up with the
call; the endpoint filters them to the `refreshes` allowlist and attaches
the re-rendered `{for, id, html, state, records}` entries. Everything is
best-effort by design: a boundary that cannot be re-rendered (or a
renderer failure) is simply omitted and the UI converges through
`invalidates`/`$cache` — declare both on a mutation for exactly that
fallback. Wire-only, like `invalidates`; meaningless with `cache`.

### Zero-JS form actions — `form: true`

The mutation-side twin of `cache` (rfc-server §6.4): declaring `form: true`
marks a function as a **form target**. The endpoint then accepts native form
POSTs (`application/x-www-form-urlencoded` / `multipart/form-data`) for it,
and — when a resume `<form>`'s submit handler calls it — the build stamps a
real `action="/_sigx/fn/<symbol>" method="post"` onto the form:

```ts
export const submitFeedback = serverFn({
    form: true,
    input: FeedbackSchema,          // load-bearing: form fields are strings
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
  strength (an Origin-less form POST is 403 under the default policy).
  Only mark genuinely intended form targets, and always declare `input`.
- JSON callers of the same fn are untouched — same envelope, same errors.

### Cacheable reads — GET + `Cache-Control`

The read-side twin of `invalidates` (rfc-server §4.1): declaring `cache`
marks a function as a **side-effect-free idempotent read**. The stub then
calls it with `GET {endpoint}/{symbol}?args=…` and the endpoint emits
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
  exclusive.
- Every non-2xx GET is `no-store`; a handler-set `cache-control` (via
  `rq.responseHeaders`) wins for dynamic per-input TTLs. POST stays valid
  for every function.
- Layering with `@sigx/cache`: `staleTime` decides *when* to refetch,
  `max-age` decides whether the refetch reaches the origin. For private
  reads keep `maxAge ≤ staleTime`; for public reads put the real budget in
  `sMaxAge` and keep the browser `max-age` short.

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
    rq.locals;           // guard hand-off (auth results)
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

`runWithServerFnContext` uses `AsyncLocalStorage`, so the request survives
every `await` in the render without threading a parameter through user code.
It needs Node, Deno, or workerd with `nodejs_compat`; where it is missing the
render runs unscoped rather than failing, and form 1 behaves identically. `.with({ context })` wins over ambient, and
with neither the throw stays — a function reading `rq.request` when nothing
supplied one is a bug worth seeing, not a silent `undefined`.

`context` accepts a `Request` or a partial `ServerFnContext` (to set `locals`,
say). A supplied `Request` also supplies `rq.abortSignal`, so wire its signal
to the client disconnect (`res.once('close', …)` under Node) and SSR-time work
stops when the client goes away. `rq.responseHeaders`/`rq.status()` stay inert
either way: there is no
HTTP response to affect, and pretending otherwise would silently drop headers.
On the client `.with({ context })` is ignored, with a dev warning — a stub's
context is the request it makes.

## The endpoint

`POST /_sigx/fn/<symbol>` with `{"args": [...]}` → `{"data": ...}` or
`{"error": {message, status, data?}}`. Symbols are content-hashed, so a
stale client gets a typed version-skew error, never a silent wrong call.

Dev needs no wiring — the `sigxServer()` Vite plugin serves the endpoint
from `vite.middlewares`. Production mounts the handler beside the document
handler, fed by the build's registry chunk:

```js
import { createServerFnHandler } from '@sigx/server/node';

const { serverFns } = await import('./dist/server/sigx-server-fns.js');
app.use(createServerFnHandler({ functions: serverFns, guard: requireSession }));
app.use(createRequestHandler({ /* documents, unchanged */ }));
```

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
    // Upper bound on guard + handler (+ a stream's first chunk). On
    // expiry: 504 to the caller, rq.abortSignal fires, onError sees the
    // timeout. A STARTED stream is not bounded (time-to-first-byte only).
    timeoutMs: 10_000
}));
```

`ServerFnError`s are expected, client-visible errors — they do not fire
`onError`. Prod masking is unchanged: the caller still sees a generic 500.

### Cancellation — `.with({ signal })`

Every `serverFn` callable carries a per-call options channel
(`serverStream` deliberately doesn't — a stream consumer's
`break`/`return()` already aborts the fetch). Inside a
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
| **circular structures** | ❌ still an error — the one unsupported shape |

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
(`@acme/api/src/cart.server.ts#addToCart`) is what `role: 'client'` builds
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

Deploy note: stable symbols URL-encode into one path segment
(`%2F`-encoded slashes). A proxy or CDN that decodes or merges encoded
slashes will mangle them — hashed symbols are immune; configure the proxy
to pass encoded paths through untouched.

## Security defaults

Every server function is a public HTTP endpoint; the defaults assume that:

- **POST-only**, required `application/json` media type, and a same-origin
  `Origin` check (CSRF posture). `origin: 'verify-when-present'` verifies
  the header when present and admits header-less programmatic clients
  (native apps, CLIs, server-to-server) — browser CSRF stays independently
  blocked by the non-safelisted JSON content-type, and `Origin: null` is a
  present header and still rejected. Never deploy an Origin-stripping
  proxy in front of a cookie-authenticated app under that policy. An
  allowlist or `origin: false` makes it a deliberate public API.
- **`guard` hook** runs before every function, for every transport — the
  app-wide auth seam. Per-function `use` chains compose on top.
- **`maxBodyBytes`** (1 MiB default) enforced while reading.
- **Error masking**: only `ServerFnError` crosses the wire verbatim; other
  throws become a generic 500 in production.
- **Prototype-pollution keys dropped** from parsed values on both parse
  sites (a reviver removes `__proto__`/`constructor`/`prototype`; the
  request itself is not rejected).

## Entry points

| Entry | Runs on | What |
|---|---|---|
| `@sigx/server` | server (browser condition throws) | `serverFn`, `ServerFnError`, `isServerFnError`, types |
| `@sigx/server/client` | any client (browser, lynx, terminal) | the generated stubs' runtime + `configureServerFn` (dependency-free) |
| `@sigx/server/server` | anywhere (WinterCG) | `handleServerFnRequest(request, options)` |
| `@sigx/server/node` | Node | `createServerFnHandler(options)` — connect-style |

The runnable example is `examples/resume` (the "server function from a
resumed handler" card).
