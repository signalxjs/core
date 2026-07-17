# RFC: `@sigx/server` — server functions (RPC), the sigx way

Status: **proposed / under review**. Tracking: signalxjs/core#302.
Pre-1.0, no-compat (same stance as `rfc-async.md` and `rfc-ssr-platform.md`):
one way to do it.

Relationship to the other RFCs:

- **Fills the door `rfc-ssr-platform.md` reserved.** Its "What this RFC does
  not do" names this exact feature: *"Server functions / actions (RPC). The
  value-first async RFC's manual writes (#135: `useAction` + `.run`) will
  eventually want a 'fetcher runs on the server' transport. That is a
  compiler + transport problem — a separate future RFC."* This is that RFC.
- **Builds on `rfc-async.md`** (merged): `useData` is THE read, `useAction`
  is THE write, and the §7 engine seam is how packs extend both. This RFC
  adds **no call-site primitive** — a server function is a plain async
  function precisely so it slots into both untouched, and so `@sigx/cache`
  applies with zero integration code.
- **Rides `@sigx/resume`'s extraction discipline** (#241, #248): file
  conventions over `$` markers, static free-variable analysis over closure
  serialization, content-hashed symbols, "the build knows — the runtime
  doesn't guess." A resumed handler importing a server function composes
  with **zero changes** to the resume capture rules (§1.3).
- **Stays a pack.** Like islands, resume, and cache, `@sigx/server` rides
  public seams only: the Vite plugin surface, the request-handler options,
  and the serializer discipline. `@sigx/server-renderer` core learns nothing
  about RPC. (`@sigx/server` is the client↔server *interaction* layer;
  `@sigx/server-renderer` renders documents. Adjacent, not overlapping.)

## Problem — stated against the current code

1. **Resumability stops at the network.** `@sigx/resume` ships pages whose
   only script is the 1 KB loader, and extracted handlers
   (`data-sigx-on:*` → content-hashed symbols → lazy chunks) run entirely
   client-side (`packages/resume/src/client/index.ts`,
   `qrl-registry.ts`). The moment a handler needs the server — a mutation, a
   query, anything with a database — the story collapses to "hand-write a
   fetch endpoint in `server.mjs`." The framework that eliminated hydration
   boilerplate reintroduces API boilerplate one layer down.
2. **`useData`/`useAction` have no server-side transport.** rfc-async
   deliberately scoped fetchers as "any async function" and left the
   "fetcher runs on the server" transport to this RFC. Today every SSR app
   writes `fetch('/api/…')` fetchers plus matching Express routes by hand —
   untyped at the boundary, duplicated validation, no shared serialization
   discipline with the boundary/state pipeline that already exists
   (`packages/server-renderer/src/server/serialize.ts`).
3. **The prior art has known footguns we can dodge at design time.** Qwik's
   `server$`: layout middleware does not run for RPC requests (a documented
   auth-bypass trap), closures capture *serialized client-controlled values*
   (a documented confusion source and an injection surface), and version
   skew surfaces as an opaque 404. React server actions serialize closures
   outright. TanStack's `createServerFn` gets validation and middleware
   right but is its own call-site builder. sigx can take the good parts —
   mandatory-feeling validation, definition-level middleware — without the
   bad ones.

## §1 Design thesis

### 1.1 Two authoring forms, one machinery

**(a) The `*.server.ts` module.** Default include:
`**/*.server.{ts,tsx}` (configurable, mirroring `SigxResumeOptions`). The
whole module is server-only: it may import anything — database clients,
`node:` builtins, secrets. The **server** build leaves it untouched. The
**client** build never bundles it; the transform swaps the entire module
for generated stubs:

```ts
// src/cart.server.ts — only ever executes on the server
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';
import { sessionFrom } from './auth';

export const addToCart = serverFn(async (rq, productId: string, qty: number) => {
    const user = await sessionFrom(rq.request);
    if (!user) throw new ServerFnError(401, 'sign in first');
    return db.cart.add(user.id, productId, qty);
});
```

```js
// what `import './cart.server'` resolves to in the BROWSER build
import { __serverFnStub } from '@sigx/server/client';
export const addToCart = __serverFnStub('addToCart_fn_9f3a01cc');
```

A stub is a same-signature async function that POSTs
`{"args": [...]}` to the fn endpoint (§4) and resolves the result. During
SSR the import is the real module, so a call is a direct invocation — no
network hop. Same import, both sides; TypeScript types flow through
untouched.

Non-`serverFn` **value** exports of a `*.server.ts` module become throwing
`__serverOnly` stubs on the client (server code cannot leak into the bundle
by accident; the error names the file). Type-only exports pass through, so
"types + fns in one file" stays a supported layout.

**(b) Inline `serverFn` in component files.** For one-offs where a separate
file is ceremony, `serverFn` may be declared at module scope of any
client-reachable file:

```tsx
// src/Search.tsx — co-located
import { component, useData } from 'sigx';
import { serverFn } from '@sigx/server';
import { searchIndex } from './search-index';   // server-only dep

const search = serverFn(async (rq, q: string) => searchIndex.query(q, { limit: 20 }));

export const Search = component((ctx) => {
    const q = ctx.signal('');
    const results = useData(() => ['search', q.value], () => search(q.value));
    /* … */
});
```

The transform lifts the body into a generated server-only module (imports
replicated — the `.handlers.ts` pattern from resume), replaces the
declaration with the same stub, and **strips imports left unused in the
client file** (otherwise dev mode — no tree-shaking — would load
server-only deps in the browser).

Both forms mint the same symbols, feed the same registry, and hit the same
endpoint. The file form is the default recommendation (server-heavy
modules, shared functions); the inline form is sugar for locality.

### 1.2 The imports-only capture rule (no closure serialization, ever)

An inline `serverFn` body may capture **imports and globals only**.
Component scope, signals, props, and file-local variables are a **hard
build error** — not a degrade, not a warning:

```
[sigx server] serverFn cannot capture component scope ("q") — the body runs
on the server, where "q" does not exist. Pass it as an argument:
serverFn(async (rq, q: string) => …) and call search(q.value).
```

This is resume's own discipline pointed at a new boundary. Resume already
refuses to serialize closures and instead statically rewrites permitted
captures (`packages/vite/src/resume-extract.ts` — the capture
classification around lines 830–886, where imported bindings are the legal
case at 863–871). `serverFn` reuses the same scope-aware free-variable
scanner (`scanHandler`) with a *simpler* verdict: imports pass, everything
else errors.

Contrast with the field: React server actions serialize captured closure
variables to the client (encrypted, still attack surface); Qwik's `server$`
captures serialize values that then arrive back *from the client* — what
looked like server-side state is client-controlled input. Under the
imports-only rule, data crosses the boundary **only as typed arguments**,
and arguments are exactly what the validator seam (§2) validates. The
boundary is explicit or it does not compile.

### 1.3 Resume composes for free

A resumed handler that imports a server function needs **zero changes to
the resume extractor**: an imported binding is already a legal capture,
replicated into the handler chunk; the replicated import resolves to the
client stub (the stub module is what that specifier *is* in the client
environment).

```tsx
// src/Buy.resume.tsx — zero JS on the page until clicked
import { component } from 'sigx';
import { addToCart } from './cart.server';

export const Buy = component<{ sku: string }>((ctx) => {
    const count = ctx.signal(0);
    return () => (
        <button onClick={async () => { count.value = await addToCart(ctx.props.sku, 1); }}>
            In cart: {count.value}
        </button>
    );
});
```

Runtime story: page ships the loader only → click → handler chunk loads →
stub POSTs → server does the db work → result lands in the resumed scope →
upgrade-on-write renders the new count. The database code never gets near
the browser. This pairing — resumability for the *code*, server functions
for the *work* — is the point of the RFC.

### 1.4 A server function is a plain async function

No `query()`, no `rpc()`, no action builder. The wrapped value type-checks
as `(...args) => Promise<R>`, so:

```tsx
const cart = useData(() => ['cart'], getCart, { cache: { staleTime: 30_000 } });
const add  = useAction(addToCart,   { cache: { invalidates: [['cart']] } });
```

`useData` is the read, `useAction` is the write, and the whole
`@sigx/cache` pack (staleTime, `invalidate()`, optimistic `mutate`) applies
through the rfc-async §7 engine seam with **zero integration code** — the
seam neither knows nor cares that the fetcher crosses the network. This is
the headline over Qwik's `server$`, which returns a bare promise and leaves
loading/error/staleness UX to every call site.

## §2 Public API — `@sigx/server`

```ts
/** Request context — first parameter, sigx idiom (no `this`). */
export interface ServerFnContext {
    request: Request;                    // WinterCG Request (request headers live here)
    url: URL;
    signal: AbortSignal;                 // fires on client disconnect
    responseHeaders: Headers;            // mutable response headers
    status(code: number): void;          // response status override
    locals: Record<string, unknown>;     // guard/middleware hand-off (auth results)
}

/** Direct form. */
export function serverFn<A extends unknown[], R>(
    impl: (rq: ServerFnContext, ...args: A) => R | Promise<R>
): (...args: A) => Promise<Awaited<R>>;

/** Options form — the safety seams. */
export function serverFn<S, A extends unknown[], R>(options: {
    /**
     * Input validator; ALWAYS runs server-side before the handler.
     * Typed against the Standard Schema spec (`StandardSchemaV1` from
     * `@standard-schema/spec`, the interface Zod/Valibot/ArkType all
     * implement — a type-only dependency). Exact pin happens at
     * implementation time.
     */
    input?: StandardSchemaV1<S>;
    /** Definition-level middleware — no transport can skip it (RPC, form POST, in-process SSR call). */
    use?: ServerFnGuard[];
    handler: (rq: ServerFnContext, input: S) => R | Promise<R>;
}): (input: S) => Promise<Awaited<R>>;

/** Streaming form (§6.1): async generator → client AsyncIterable. */
export function serverStream<A extends unknown[], T>(
    impl: (rq: ServerFnContext, ...args: A) => AsyncGenerator<T>
): (...args: A) => AsyncIterable<T>;

/** Passes through the wire verbatim; everything else is masked (§5). */
export class ServerFnError extends Error {
    readonly __sigxServerFnError: true;  // brand, NOT instanceof — dev module
                                         // graphs differ between the Vite
                                         // runner and Node (see vite/src/ssr.ts)
    constructor(status: number, message: string, data?: unknown);
}
```

Notes:

- **Ctx-first parameter** is the sigx idiom (`component((ctx) => …)`,
  extracted handlers `($scope, e) => …`). No `this` (Qwik), no ambient
  `getRequestEvent()` global (Solid) in v1 — explicit beats ambient, and it
  makes the in-process SSR call semantics obvious (§7 v1: a detached
  context whose `request` throws a descriptive dev error; AsyncLocalStorage
  ambient context is the v1.1 follow-up for SSR-time calls that need the
  real request).
- **`use` guards are part of the function's definition**, so they run for
  every transport — the structural fix for Qwik's "layout middleware does
  not run for `server$`" auth trap. App-wide auth belongs in the handler's
  `guard` option (§4), which runs unconditionally before every function;
  per-fn `use` chains compose on top. `rq.locals` is the hand-off.
- Subpath layout (mirrors resume's):
  - `@sigx/server` — `serverFn`, `serverStream`, `ServerFnError`, types.
    Isomorphic marker; the browser export condition ships throwing variants
    (defense in depth — the transform should have replaced every use).
  - `@sigx/server/client` — `__serverFnStub`, `__serverOnly`. **Dependency-
    free** (a bare `fetch` wrapper), so replicating the import into resume
    handler chunks keeps their no-runtime guarantee.
  - `@sigx/server/server` — `handleServerFnRequest(request, opts): Promise<Response>`,
    WinterCG-clean (edge-safe, `pnpm test:edge` discipline).
  - `@sigx/server/node` — `createServerFnHandler(options): NodeRequestHandler`,
    the connect-style sibling of `createRequestHandler`
    (`packages/server-renderer/src/node.ts` — same "copyable handler, not a
    meta-framework" posture).

## §3 The transform — `@sigx/vite/server`

Two modules in `packages/vite/src`, mirroring the resume split (pure
analysis + plugin):

**`server-fn-extract.ts`** (pure, unit-testable):

```ts
export interface ServerFnExtraction {
    fns: { name: string; symbol: string }[];   // serverFn/serverStream exports
    serverOnly: string[];                      // unwrapped value exports
    stubModule: string;                        // full client replacement source
    liftedModule?: string;                     // inline form: generated server module
}
```

- Recognizes `serverFn`/`serverStream` by **import tracking** from
  `@sigx/server` (the same discipline `componentFactories` uses for
  `component` — aliases work, look-alikes don't).
- **Symbol format:** `<name>_fn_<hash8(relPath + '\0' + name + '\0' + implSource)>`,
  reusing resume's FNV-1a `hash8` (`resume-extract.ts` — currently
  module-private; exporting it is a one-line change). The `_fn_` infix keeps
  server symbols visually distinct from resume's `<Component>_<event>_<hash8>`.
  Content-hashing makes **version skew self-announcing**: a stale client
  posts an old symbol and gets a structured 404 the stub converts into a
  typed "stale build — reload?" error (never a silent wrong-function call).
- `*.server.ts` files: client environment → `stubModule`; SSR environment →
  untouched (the `serverFn` wrapper is pure runtime there).
- Inline form: scan files importing `@sigx/server` for module-scope
  `serverFn(...)`; run the free-variable check (imports-only, §1.2, hard
  error via `this.error`); lift bodies into a generated
  `\0<file>.serverfns.ts` module with replicated imports; replace
  declarations with stubs; strip now-unused imports. In the SSR environment
  the body stays in place (direct invocation).

**`server-fn.ts`** — `sigxServer(options?)` plugin, `enforce: 'pre'`,
structured like `sigxResume`:

- `configResolved`: discover via `walkFiles` (shared with islands/resume)
  into an in-memory `Map<file, ServerFnExtraction>`; `transform` re-extracts
  per file (authoritative dev path); `hotUpdate` invalidates stubs +
  registry virtual module — symbol changes propagate because importers
  re-transform.
- `virtual:sigx-server-fns` (SSR environment only) — the prod registry:

  ```js
  export const serverFns = {
      "addToCart_fn_9f3a01cc": () => import("/abs/src/cart.server.ts").then(m => m.addToCart),
  };
  ```

  emitted as a named chunk → `dist/server/sigx-server-fns.js` next to
  `entry-server.js`. This is the resume-manifest posture — **explicitly
  passed, never ambient**; the server has a module system, so lazy import
  records suffice (no JSON manifest).
- `configureServer`: the **dev endpoint** inside `vite.middlewares`
  (precedent: the Cache-Control middleware in `packages/vite/src/index.ts`).
  Every example already mounts `vite.middlewares` before the dev request
  handler, so dev needs no example wiring. Resolution: symbol → extraction
  map → `ssrLoadModule(file)` → export. The shared request logic is itself
  loaded via `ssrLoadModule('@sigx/server/server')` for module-graph
  identity (the exact concern `vite/src/ssr.ts` documents); cross-graph
  error identification uses the `__sigxServerFnError` brand, never
  `instanceof`.
- Dev lint: `serverFn` referenced in a file that neither matches the
  include pattern nor gets inline extraction → `this.warn` (the body would
  ship to the client).

Prod wiring (`examples/resume/server.mjs` pattern):

```js
const { serverFns } = await import('./dist/server/sigx-server-fns.js');
app.use(createServerFnHandler({ functions: serverFns, guard: requireSession }));
app.use(createRequestHandler({ /* unchanged */ }));
```

## §4 Wire format & endpoint

```
POST {base=/_sigx/fn}/{symbol}
content-type: application/json        ← REQUIRED (415 otherwise)
origin: <same-origin>                 ← REQUIRED by default (403 otherwise)

{"args": [ ... ]}
```

Responses (all `application/json`):

- `200 {"data": <json>}` — absent `data` key ⇒ resolved `undefined`.
- `<status> {"error": {"message", "status", "data"?}}` — a thrown
  `ServerFnError(status, msg, data)` passes through verbatim; **any other
  throw is masked to `500 {"error":{"message":"Internal error"}}` in prod**
  (`__DEV__` includes message + stack).
- `400` malformed body / non-array args / validator rejection (validator
  issues in `data`); `403` origin; `404` unknown symbol (stub throws the
  skew-aware error); `405` + `allow: POST`; `413` over `maxBodyBytes`;
  `415` wrong content-type.

Handler options (shared by `/server` and `/node`):

```ts
export interface ServerFnRequestOptions {
    resolve(symbol: string): Promise<Function | null | undefined>;
    /** Runs unconditionally before EVERY function — THE app-wide auth seam. */
    guard?(rq: ServerFnContext, fn: { symbol: string; name: string }): void | Promise<void>;
    origin?: 'same-origin' | string[] | false;   // default 'same-origin'
    maxBodyBytes?: number;                        // default 1_048_576, enforced while reading
}
```

Serialization: v1 is JSON, inheriting the boundary pipeline's key
discipline — the serializer already refuses `DANGEROUS_KEYS`
(`__proto__`/`constructor`/`prototype`,
`server-renderer/src/server/serialize.ts`). That pipeline has no parse
step (it emits script assignments); the RPC envelope *does* parse, so it
**adds** reviver-based rejection of those same three keys at both parse
sites (server args, client result; the set is duplicated in `/client` to
keep the stub dependency-free). **Rich
type-handler serialization (Date, Map, custom classes) is deferred** until
the client *revive* side of the serializer seam exists —
`runtime-core/src/ssr-serialize.ts` is explicitly serialize-only today
("the client revive side ships with the cache-seed work"). When it lands,
the RPC envelope adopts the same `SSRTypeHandler` registry on both
directions; the envelope shape does not change.

## §5 Security — first-class design content

The core truth: **every server function is a public HTTP endpoint.** Types,
client-side checks, and component boundaries constrain your code, not an
attacker with `curl`. Defaults, in order of the failure they prevent:

1. **Auth bypass** — the `guard` hook lives *inside* the request handler
   and runs before every function, for every transport; per-fn `use` chains
   are part of the definition (§2). There is no separate middleware
   universe to forget (Qwik's trap). Dev and prod enforce the same guard.
2. **CSRF** — POST-only + required `application/json` content-type (forms
   cannot send it cross-origin without a preflight) + same-origin `Origin`
   check by default. Opting out (`origin: false` or an allowlist) is
   explicit and documented as "you are now a public API."
3. **Injection via 'captured' state** — structurally impossible: the
   imports-only rule (§1.2) means nothing crosses the boundary except typed
   arguments, and the `input` validator runs server-side on exactly those.
4. **DoS** — `maxBodyBytes` enforced during body read, not after.
5. **Prototype pollution** — reviver-based key rejection on both parse
   sites (§4).
6. **Error leakage** — non-`ServerFnError` messages and stacks are masked
   in prod; `ServerFnError` is the deliberate channel.
7. **Version skew** — content-hashed symbols; stale clients get a typed,
   actionable error (§3), never a silent wrong call.
8. **Header/cookie races** — v1 responses are buffered JSON;
   `rq.responseHeaders` / `rq.status()` apply before the body is written.
   (Qwik's cookie-after-stream-start failure cannot occur.) The streaming
   form (§6.1) documents that headers freeze at the first yield.

## §6 Beyond parity — what the architecture uniquely enables

Phased (§7); designed here so the v1 envelope reserves the right fields.

### 6.1 Streaming lands in `useStream`

`serverStream(async function* …)` streams yields as NDJSON
(`{"chunk":…}` lines, then `{"done":1}` or `{"error":…}`); the stub
returns an `AsyncIterable<T>`. Where Qwik hands you a raw iterator, sigx
has a home for the common case: `useStream`
(`runtime-core/src/use-stream.ts`) is string-specific
(`() => AsyncIterable<string>`), so a **string-yielding** `serverStream`
plugs in as-is — no `useStream` API change in this RFC. Non-string streams
are consumed manually with `for await`; whether `useStream` ever grows a
generic accumulate form is a separate rfc-async follow-up, not designed
here:

```tsx
const text = useStream(`explain:${id}`, () => explain(id));
// <p>{text.value}</p> — progressive text, no new client concept
```

Client `break`/`return()` aborts the fetch; `rq.signal` fires server-side.

### 6.2 Server-declared cache directives

The response envelope reserves `$cache`:
`200 {"data": …, "$cache": {"invalidates": [["cart","42"], …]}}`.
`serverFn({ invalidates: (input, result) => [...] })` declares invalidation
**where the data actually changed**; `@sigx/cache` registers an envelope
hook (pack-to-pack, mirroring how cache rides the engine seam) that feeds
`invalidate()` on arrival. Client-side `cache.invalidates` still works;
server-declared is the better default because it cannot drift from the
mutation. TanStack makes the client declare this; Qwik has nothing here.

### 6.3 Single-flight boundary refresh

Boundary records are self-describing — `SSRBoundaryRecord` carries the
component registry key, `props`, and `state`
(`packages/server-renderer/src/boundary.ts`). So a mutation call can name
boundaries to refresh; the server re-renders **just those components**
through the same per-request app + resume plugin (fresh HTML *and* fresh
state via the existing tracking-signal capture), and the envelope returns
`{"data": …, "$boundaries": [{id, html, state}]}`:

- **Resumed (never-hydrated) boundaries:** DOM swap between the boundary
  element and its marker + `record.state` overwrite + scope refresh. The
  component updates **without ever loading its chunk** — the server does
  the thinking, the client patches pixels. Qwik cannot do this; Solid's
  single-flight re-runs whole route loaders.
- **Upgraded boundaries:** skip the HTML; write `state` through the live
  signals — fine-grained reactivity patches the DOM.
- Boundaries with non-serializable DI needs decline (`refreshable: false`)
  and fall back to §6.2 invalidation. A refresh landing mid-upgrade is
  dropped (the upgrade's live state wins).

One request: mutation + fresh UI.

### 6.4 Zero-JS form actions

A `<form>` whose submit handler calls a server function gets real
`action="/_sigx/fn/<symbol>" method="post"` stamped at build time. The
endpoint goes dual-mode: `application/json` → RPC envelope;
`application/x-www-form-urlencoded`/`multipart` → the `input` validator
normalizes FormData, run the fn, `303` POST-redirect-GET.

- JS loaded: delegation intercepts submit → RPC → single-flight patch (6.3).
- JS off, failed, or not yet loaded: the native POST works.

The interaction resumability exists to never drop becomes *undroppable* —
it doesn't even need the loader. One `serverFn`, one validator, two
transports. (Qwik City's `routeAction$`/`<Form>` has a progressive story;
the sigx plus is that the same function serves both transports and the
page still ships ≤1 KB of JS.)

### 6.5 Research: extracted DOM bindings — write without upgrade

Today any facade write triggers upgrade-on-write. The transform already
statically analyzes components; extend it to recognize *simple* JSX
bindings of named signals (text, attribute, class toggle) and stamp them
(`data-sigx-bind:text="count"`). A write to a signal all of whose DOM uses
are extractable patches those nodes directly — no upgrade. Combined with
server functions: handler chunk → RPC → write `$scope.signals.total` →
bind-patch. **Interactive components with no component code on the client
at all** (loader + a handler chunk measured in hundreds of bytes). Qwik
still resumes the component to run it; this skips the component. High
complexity (binding expressions; lists are out of scope) — research
prototype on text bindings first, not committed design.

## §7 Phasing

- **v1**: `serverFn` (both authoring forms), transform + dev endpoint +
  prod registry chunk, `/client` stubs, `/server` + `/node` handlers,
  `input` validator seam, `guard` + `use`, all §5 defaults, envelope with
  `$cache`/`$boundaries` reserved. Detached SSR context (in-process call =
  direct invocation). Implementation may sequence file-form first, inline
  right behind, within the same milestone.
- **v1.1**: AsyncLocalStorage ambient request context (`/node`) so SSR-time
  calls see the real request; per-fn guard overrides.
- **v2**: `serverStream` → `useStream` (6.1); server-declared cache
  directives (6.2) with `@sigx/cache`; zero-JS forms (6.4); per-call
  options (AbortSignal pass-through, headers); GET + cache semantics for
  idempotent reads; rich type-handler wire serialization once the revive
  side of the serializer seam ships.
- **v2+**: single-flight boundary refresh (6.3) once the envelope and the
  per-request re-render path are proven.
- **Research**: bind extraction / write-without-upgrade (6.5), and a
  `serverComputed` sugar on top of it.

## What this RFC does not do

- **Closure capture or serialization of any kind.** Inline `serverFn` is
  supported *only* under the imports-only rule; captured component/file
  scope is a build error, never a serialized value. (React-actions-style
  encrypted closures and Qwik-style captured-value round-trips are both
  rejected — same reasoning as resume's no-closure stance, sharpened by the
  injection surface.)
- **A separate read/write primitive.** No `query()`, no `rpc()`, no action
  builder — `useData` is the read, `useAction` is the write (rfc-async).
- **Wrapper components.** No `<ServerBoundary>`, no RPC-Suspense.
  Everything here is functions and attributes.
- **RPC machinery in `@sigx/server-renderer` core.** `@sigx/server` is a
  pack riding public seams; the request handlers gain nothing but the
  documented mount pattern (the fn handler is a sibling middleware, not an
  option of `createRequestHandler`).
- **A meta-framework.** No file-system routing; `*.server.ts` is a build
  convention, not a route convention.

## Compatibility

- Purely additive: new package `@sigx/server`, new Vite plugin export
  `@sigx/vite/server`, one exported helper (`hash8`) from the resume
  transform internals.
- `@sigx/resume` runtime, extractor capture rules, loader, and wire
  attributes: unchanged.
- `@sigx/server-renderer` public API: unchanged (the fn handler mounts
  beside `createRequestHandler`).
- `useData`/`useAction`/engine-seam contracts (rfc-async): unchanged — a
  server function is a plain async fetcher by construction.
- Envelope fields `$cache`/`$boundaries` are reserved in v1 and ignored by
  clients that don't know them, so v2 features are non-breaking.
