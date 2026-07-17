# RFC: `@sigx/server` — server functions (RPC), the sigx way

Status: **v1 implemented (v0.12.0 — #306, #308); rev 2 — native clients —
implemented (#320: runtime half #329, build half follows it)**. Tracking:
signalxjs/core#302 (v1), signalxjs/core#318 (rev 2).
Pre-1.0, no-compat (same stance as `rfc-async.md` and `rfc-ssr-platform.md`):
one way to do it.

> **rev-2 changes** (native clients — the third role): v1 modeled two roles,
> a same-origin browser client and a Node SSR renderer. A **lynx or terminal
> app calling a remote sigx server** is a third role with no representation —
> rev 2 designs it: runtime transport config (`configureServerFn`), the
> `endpoint`/`base` split and a `role: 'client'` build mode, the
> `'verify-when-present'` origin posture, a hard throw when server bodies
> reach a declared live client, root-independent symbol seeds for one-solution
> multi-client builds, and **stable routes** so backend deploys never break
> installed apps. See "Native clients — the third role" below; §3, §5, and §7
> are amended in place. Grounded against the real platform repos:
> signalxjs/terminal (Vite-built, already on `@sigx/vite`; must add
> `declareLiveClient()`) and signalxjs/lynx (rspeedy/Rsbuild-built, native
> WHATWG `fetch` via `@sigx/lynx-http`, `declareLiveClient()` wired).

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

/** Guard/middleware: veto by throwing; hand results downstream via rq.locals. */
export type ServerFnGuard = (
    rq: ServerFnContext,
    fn: { symbol: string; name: string }
) => void | Promise<void>;

/** Passes through the wire verbatim; everything else is masked (§5). */
export class ServerFnError extends Error {
    readonly __sigxServerFnError = true; // initialized field, so the brand exists
                                         // at runtime; checked as a brand, NOT
                                         // instanceof — dev module graphs differ
                                         // between the Vite runner and Node
                                         // (see packages/vite/src/ssr.ts)
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
  *(rev 2)* The path component of the seed becomes a **root-independent
  stable id** — a printable string joining the nearest enclosing package's
  name with the file's package-relative path
  (`@acme/api/src/cart.server.ts`; build-root-relative fallback when no
  package.json exists). The `\0` remains purely a hash-seed FIELD separator
  between id, name, and impl source (as in v1) and never appears in the
  stable id itself — the id must survive URL routing in the stable symbol
  below. This makes every app build of one solution mint the SAME symbol
  for a shared server module. All symbols regenerate once at the
  seed change; client+server deploy together, so nothing at rest breaks.
  Alongside the hashed symbol, every function also gets a hash-free
  **stable symbol** (`<stableId>#<name>`) for long-lived clients — see
  "Native clients" below.
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
      "addToCart_fn_9f3a01cc": () => import("/src/cart.server.ts").then(m => m.addToCart),
      // Vite-root specifiers, matching the resume registry's import discipline
  };
  ```

  emitted as a named chunk → `dist/server/sigx-server-fns.js` next to
  `entry-server.js`. This is the resume-manifest posture — **explicitly
  passed, never ambient**; the server has a module system, so lazy import
  records suffice (no JSON manifest). *(rev 2)* The registry
  **dual-registers** every function under its content-hashed symbol AND its
  stable symbol (see "Native clients"); server modules living outside the
  Vite root (shared workspace packages, discovered via the new `scan`
  option) use absolute-path specs here and `/@fs/` paths in the dev
  resolver — `'/' + relPath` breaks for `../` paths.
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
content-type: application/json        ← REQUIRED media type (415 otherwise);
                                        parameters tolerated, e.g.
                                        "application/json; charset=utf-8"
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
  skew-aware error); `405` + `Allow: POST`; `413` over `maxBodyBytes`;
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
`packages/server-renderer/src/server/serialize.ts`). That pipeline has no
parse
step (it emits script assignments); the RPC envelope *does* parse, so it
**adds** reviver-based rejection of those same three keys at both parse
sites (server args, client result; the set is duplicated in `/client` to
keep the stub dependency-free). **Rich
type-handler serialization (Date, Map, custom classes) is deferred** until
the client *revive* side of the serializer seam exists —
`packages/runtime-core/src/ssr-serialize.ts` is explicitly serialize-only today
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
   explicit and documented as "you are now a public API." *(rev 2)* A middle
   posture, `origin: 'verify-when-present'`, verifies the `Origin` header
   whenever it exists and allows requests without one — programmatic
   clients (native apps, CLIs, server-to-server) never send `Origin`, and an
   Origin-less request is by construction not a mainstream browser's
   cross-site POST, so it carries no victim's ambient credentials. Browser
   CSRF stays independently blocked by the non-safelisted JSON content-type
   (cross-origin browsers must preflight; this endpoint never emits CORS
   approval). `Origin: null` is a PRESENT header and still rejected. The
   default stays `'same-origin'` — serving native clients is a deliberate,
   reviewable one-line opt-in, far narrower than `origin: false`. Caveat to
   document: never deploy an Origin-stripping proxy in front of a
   cookie-authenticated app using this policy; native clients authenticate
   with token headers (CSRF-immune by construction).
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
(`packages/runtime-core/src/use-stream.ts`) is string-specific
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

## Native clients — the third role (rev 2)

v1 models exactly two roles: a **same-origin browser client** (fetch stubs,
ambient cookies, Origin-checked) and a **Node SSR renderer** (real functions,
in-process detached calls). sigx has two more real renderers —
signalxjs/lynx (iOS/Android via the Lynx engine) and signalxjs/terminal
(TUIs) — and an app on either is a **third role**: a client of a remote sigx
server. It wants stubs like the browser, but with an absolute endpoint (no
page origin on-device), explicit auth headers (no cookie jar), no `Origin`
header, its own `fetch`, and — decisive for design — a **lifetime measured in
app-store updates**, not page reloads.

The product model this section serves: **native clients always talk to the
backend** (a server body executing locally in a live client is never
legitimate), and one solution typically ships web + native + terminal apps
importing the **same `*.server.ts` modules** against **one deployed server**
— one way to talk to the backend, everywhere.

### N.1 Runtime transport — `configureServerFn`

`@sigx/server/client` (the module every stub already imports) gains
module-level transport config, resolved by stubs **at call time**:

```ts
export interface ServerFnTransport {
    /** Absolute URL or path prefix; wins over the build-time endpoint. */
    endpoint?: string;
    /** Extra request headers — static map or (possibly async) factory. */
    headers?: Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>);
    /** Fetch implementation; default is the global fetch. */
    fetch?: typeof globalThis.fetch;
}
export function configureServerFn(transport: ServerFnTransport | null): void;
```

A lynx or terminal app calls it once at startup:

```ts
configureServerFn({
    endpoint: 'https://api.example.com/_sigx/fn',
    headers: () => ({ authorization: `Bearer ${token()}` })
});
```

— and every server function in the app targets the deployed backend with
rotating credentials.
One build serves dev/staging/prod (call-time resolution). Web apps benefit
too: bearer-auth SPAs finally have a header seam. `content-type` merges LAST
and is not overridable (the endpoint 415s anything else). Zero config is
byte-identical to v1 behavior; the entry stays dependency-free under its
size-limit no-ignore-list guard.

### N.2 Build roles — `endpoint`, `role: 'client'`

`SigxServerOptions.base` conflated two meanings in v1: the client fetch
target baked into stubs AND the server mount-path prefix. Rev 2 splits them:

- **`base`** (unchanged default `/_sigx/fn`) — the SERVER mount path (dev
  middleware, `createServerFnHandler`).
- **`endpoint`** (default: `base`) — the fetch target baked into stubs; an
  absolute URL for builds that call a remote server. Precedence at call
  time: `configureServerFn` endpoint > baked `endpoint` > `base`.
- **`role: 'auto' | 'client'`** (default `'auto'`) — `'auto'` keeps v1
  behavior (stub swap in the Vite `client` environment only; web SSR
  unchanged). `'client'` declares the WHOLE build a remote-server client:
  every environment gets stubs (including a terminal app building through
  the `ssr` environment or a custom-named one) and **no registry chunk is
  emitted** — there is no server in this build.

**Live-client guard.** The remaining failure mode is a build that never runs
the transform: Node resolves the real `@sigx/server` entry (the throwing
marker is `browser`-condition-only), and server bodies would execute
locally against the detached context — silently wrong, server code leaked
into a client bundle. Rev 2 closes it: `declareLiveClient()` (the existing
platform-identity seam in `@sigx/runtime-core`) additionally stamps
`globalThis.__SIGX_LIVE_CLIENT__`, and the real `serverFn` wrapper
**throws** when invoked in a declared live client — *"server function
reached a live client unextracted — this app must call its backend over
stubs (set `role: 'client'` in `sigxServer()`, or fix the bundler
integration)"* — the exact posture of the browser condition, extended to
lynx/terminal. Not dev-only, matching the browser variant. `@sigx/server`
stays free of a runtime-core dependency (a global marker, not an import);
web SSR never stamps (the `typeof window` fallback deliberately does not).

### N.3 Stable routes — backend deploys must not break installed apps

Content-hashed symbols are the right skew story for the web: a stale page
404s and a reload fixes it. An app-store lynx app or an installed terminal
CLI **cannot reload** — under hashed-only symbols, every backend deploy that
touches a function body would break every installed client until its user
updates. Native clients need API-stable routes:

- Every function gets a hash-free **stable symbol** — `<stableId>#<name>`
  (URL-encoded path segment), where `stableId` is the §3 package-qualified
  id. The `serverFn` options form gains **`id?: string`** (read statically
  by the extractor, string literal only) for published APIs that must
  survive file moves: `serverFn({ id: 'cart/add', handler })`. Moving or
  renaming a server module WITHOUT an explicit `id` is a breaking API
  change for native clients — exactly like changing a REST route.
- The registry **dual-registers** hashed + stable symbols. Web builds keep
  emitting hashed symbols in stubs (v1 skew detection unchanged);
  `role: 'client'` builds emit STABLE symbols — installed apps keep working
  across backend redeploys.
- **Contract safety moves from routes to the validator**: argument-shape
  changes surface as the `input` validator's 400 (issues in `data` — the
  client shows "update the app"), and semantic changes are explicit
  versioning (a new export or a new `id`) — standard API evolution. The
  trade, stated plainly: hashed = wrong-call-proof but deploy-coupled
  (web); stable = deploy-durable but contract-governed (native).

### N.4 One solution, shared server modules

With web + native + terminal apps importing shared
`packages/api/src/*.server.ts`, symbols must agree across every build — the
§3 stable-id seed guarantees it (v1's build-root-relative seed would mint
per-app symbols and 404 every non-web client as skew). Shared packages
outside an app's Vite root are discovered via the new
**`scan?: string[]`** option, with absolute-path registry specs (§3). The
server app's build registers everything; each client build stubs the same
modules against the same ids.

### N.5 Non-Vite bundlers — `@sigx/vite/server-extract`

lynx apps build with rspeedy/Rsbuild, not Vite. The pure extractors
(`extractServerFns`, `extractInlineServerFns`, plus `hash8`/`offsetToLoc`)
are re-exported under a new **`@sigx/vite/server-extract`** subpath so the
lynx repo's Rspack loader can reuse the exact analysis: `*.server.*` →
`stubModule`; other files → inline extraction behind a cheap
serverFn-import gate, hard-failing on capture errors. `parseAst` stays
imported from `vite` — a pure text→AST function; the loader takes `vite` as
a build-time dependency rather than this RFC growing an injectable-parser
option (revisit only if that proves painful).

### N.6 Platform prerequisites (their repos, not this one)

- **signalxjs/terminal** (Vite-built; already depends on `@sigx/vite`):
  add the missing `declareLiveClient()` platform-identity call (without it
  `useData` hangs at `pending` — the gate `isLiveClient()` sees no window
  and no declaration); adopt `role: 'client'` + `endpoint`/
  `configureServerFn`; bump to the release carrying this rev.
- **signalxjs/lynx** (rspeedy-built; native WHATWG `fetch` installed
  globally by `@sigx/lynx-http`; `declareLiveClient()` already wired):
  an Rspack loader on `@sigx/vite/server-extract`, startup
  `configureServerFn({ endpoint, headers })`, version bump.

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
- **Native clients (rev 2, one milestone, independent of v2)**:
  `configureServerFn` + stub call-time resolution; `'verify-when-present'`;
  plugin `endpoint`/`role`/`scan`; stable-id seeds + stable symbols + dual
  registration + options-form `id`; live-client marker + throw;
  `@sigx/vite/server-extract`. Then the platform-repo adoptions (N.6).
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
- **Platform bundler integrations.** *(rev 2)* The lynx Rspack loader and
  the terminal `declareLiveClient()`/adoption changes live in their own
  repos against `@sigx/vite/server-extract` and the public seams here —
  this RFC defines the contract, not their build plumbing.

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
- *(rev 2)* Wire and envelope unchanged; every rev-2 addition is additive
  and zero-config-identical for existing web apps, with one deliberate
  exception: the stable-id symbol seed regenerates all hashed symbols once.
  Client and server ship together in v1 deployments, so nothing at rest
  breaks — and the regeneration is precisely what makes shared server
  modules coherent across the builds of one solution.
