# RFC: `@sigx/server` — server functions (RPC), the sigx way

Status: **v1 implemented (v0.12.0 — #306, #308); rev 2 — native clients —
implemented (#320 — #329, #330)**. Tracking: signalxjs/core#302 (v1),
signalxjs/core#318 (rev 2).
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
    abortSignal: AbortSignal;            // fires on client disconnect — named to
                                         // never collide with reactive signals
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
  `getRequestEvent()` global (Solid) at the CALL site — the context is always
  a parameter, which is what makes the in-process SSR call semantics obvious.
  Where its value comes from is resolved per call (**v1.1**): explicit
  `fn.with({ context })` → the ambient `runWithServerFnContext` scope → the
  detached context, whose `request`/`url` throw a descriptive error naming
  both remedies.
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
                                        "application/json; charset=utf-8".
                                        EXCEPTION: a fn declared `form: true`
                                        also accepts the two native-form
                                        media types — §6.4/§5.2b
origin: <same-origin>                 ← REQUIRED by default (403 otherwise)

{"args": [ ... ]}
```

Responses — `application/json` on the RPC transport; the §6.4 form
transport instead answers `303` on success and `text/html` on error (the
shape forks on the REQUEST content-type):

- `200 {"data": <json>}` — absent `data` key ⇒ resolved `undefined`.
- `<status> {"error": {"message", "status", "data"?}}` — a thrown
  `ServerFnError(status, msg, data)` passes through verbatim; **any other
  throw is masked to `500 {"error":{"message":"Internal error"}}` in prod**
  (`__DEV__` includes message + stack).
- `303` — form-mode success (§6.4): `Location` is handler-set >
  same-origin `Referer` > `/`; no body, no envelope.
- `400` malformed body / non-array args / validator rejection (validator
  issues in `data`); `403` origin; `404` unknown symbol (stub throws the
  skew-aware error); `405` for an unsupported method — before the symbol
  resolves the endpoint cannot know the target's methods, so the
  pre-resolution 405 (PUT, HEAD, …) advertises the endpoint's method
  universe `Allow: POST, GET`, while GET on a fn that is not a
  cache-marked read answers the resource-precise `Allow: POST` (§4.1);
  `413` over `maxBodyBytes` (form bodies gated by `content-length` —
  `request.formData()` cannot enforce the cap mid-stream, so platform
  body limits are the deeper backstop, §6.4); `414` over `maxUrlBytes`
  (GET only, §4.1); `415` wrong content-type — including a form
  content-type sent to a fn that is not `form: true` (§6.4: POST is an
  allowed method on that resource; the *media type* is what it refuses).
- Error SHAPE forks on the request content-type (§6.4): a form-typed
  request gets every error as a minimal self-contained `text/html` page
  (the requester has no JS to render JSON); JSON requests keep the JSON
  error envelope above, byte-for-byte.

Handler options (shared by `/server` and `/node`):

```ts
export interface ServerFnRequestOptions {
    resolve(symbol: string): Promise<Function | null | undefined>;
    /** Runs unconditionally before EVERY function — THE app-wide auth seam. */
    guard?(rq: ServerFnContext, fn: { symbol: string; name: string }): void | Promise<void>;
    origin?: 'same-origin' | 'verify-when-present' | string[] | false;   // default 'same-origin'
    maxBodyBytes?: number;                        // default 1_048_576, enforced while reading
    maxUrlBytes?: number;                         // default 8_192 — cap on a GET read's
                                                  // `args` query value (§4.1); 414 over it
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
keep the stub dependency-free).

**Rich type-handler serialization has landed** (#364). The revive half of the
serializer seam now exists in `packages/runtime-core/src/ssr-serialize.ts`
(`encodeWithHandlers` / `reviveWithHandlers`, around an `SSRTypeHandler` that
gained a `tag` and a `revive` member), and the RPC envelope adopts the same
vocabulary **on both directions** — arguments as well as results, plus stream
chunks and `ServerFnError.data`. As promised, **the envelope shape does not
change**: tags live *inside* the values, so `{"args": […]}` in and
`{"data": …}` out are untouched, and `$cache` keeps working beside them.

Encoded values take the single-key form `{ [tag]: payload }`. The built-in
vocabulary works with zero configuration — `$date`, `$map`, `$set`,
`$bigint`, `$url`, `$regexp`, `$undef` — and app-registered handlers are
consulted *before* it, so a pack can own a type the built-ins also cover.
Two rules make it safe to grow:

- A user object whose sole key starts with `$` is emitted as
  `{ $esc: original }` and unwrapped on revive **without** interpreting the
  inner key. Without this, `{ $date: 'a string' }` would come back a `Date` —
  data corruption, not a missing feature.
- An unrecognized tag is left in its encoded shape rather than throwing, so a
  peer on a newer vocabulary degrades instead of failing. That is why the
  envelope still needs **no version field**.

Decoding happens *after* the prototype-pollution reviver, so dangerous keys
are already gone before any tag is interpreted; a malformed tag payload in a
request is a **400**, not a masked 500. Circular structures remain the one
unsupported shape and still fail — which is also why #351's interim
`warnNonJsonSafe` dev guardrail is now **removed**: it existed to make the
JSON-only wire's silent corruption visible, and the wire carries those types
for real now.

The codec is **shared, not reimplemented**: `@sigx/server` imports
`@sigx/serialize`, and `packages/server/src/wire-codec.ts` is only the
transport binding (where this boundary's handlers come from). `@sigx/serialize`
is dependency-free for exactly this reason — `@sigx/server/client` is itself
dependency-free by contract, since resume handler chunks replicate stub
imports and a zero-JS page must not pull the framework to make one RPC call.
size-limit still measures that entry with **no ignore list**, so every byte
the stub reaches is counted; sharing costs ~80 B over an inlined copy, which
is the deliberate price of one implementation instead of two that drift.

The alternative was tried and rejected during implementation: a duplicated
codec in `@sigx/server` (the `DANGEROUS_KEYS` posture) grew the same `$esc`
bug in both copies before either shipped. Measurement settled it — importing
and tree-shaking the codec costs 909 B, not the runtime-sized cliff the
dependency-free rule is there to prevent.

### §4.1 GET for idempotent reads (#354)

Every call above is POST — correct for the CSRF posture (§5.2), but it
means no read is ever CDN- or browser-cacheable: an edge cache can never
absorb read traffic. A read-shaped function can opt into GET:

```ts
// src/catalog.server.ts
export const getProduct = serverFn({
    input: z.object({ id: z.string() }),
    cache: { maxAge: 60, staleWhileRevalidate: 300 },   // ← the opt-in
    handler: async (rq, { id }) => db.products.get(id)
});
```

**The opt-in is `cache`, on the options form only.** Not a `query()`
primitive (rejected below in "What this RFC does not do"), not a
`method: 'GET'` option — semantics first: `cache` declares *this function
is a side-effect-free idempotent read*, and GET is the consequence. It is
the read-side twin of the shipped mutation-side `invalidates` (§6.2). The
options form's single-input shape is what gives GET a clean one-value URL
encoding, and restricting the option to that form makes the compiler
enforce it — the variadic form cannot be marked. Declaring both `cache`
and `invalidates` is a category error (`__DEV__` warning; a read that
invalidates is not a read).

```ts
export interface ServerFnReadCache {
    /** Seconds the response is fresh in HTTP caches (max-age). Required — no invented default TTL. */
    maxAge: number;
    /** stale-while-revalidate window, seconds. */
    staleWhileRevalidate?: number;
    /**
     * Shared-cache opt-in: emits `public` (+ `s-maxage`). Default false → `private`.
     * Contract: a public read's output must depend ONLY on its arguments —
     * never cookies, auth, or any other request header (§5.2a).
     */
    public?: boolean;
    /** Shared-cache TTL when public; defaults to maxAge. */
    sMaxAge?: number;
}
```

**The wire:**

```
GET {base=/_sigx/fn}/{symbol}?args=<encodeURIComponent(JSON.stringify(encode(args)))>
```

After percent-decoding, the query value is the same JSON text the POST
body carries as its `args` array — one `JSON.stringify(encode(args))`
feeds both transports (the body wraps it in `{"args": …}`, the URL wraps
it in `encodeURIComponent`), so
every tag (`$date`, `$map`, `$bigint`, `$esc`, …) survives with no second
serialization format to drift. Arguments ride the *query string*, never
the path — proxies and CDNs path-normalize `%2F` but do not touch query
values, so the #355 stable-symbol hazard is not worsened, and whatever
resolution #355 picks composes untouched. Encoding is deterministic
(objects walk in insertion order), so a call site with equal inputs mints
the identical URL — which is all an HTTP cache key needs. Two call sites
spelling `{b, a}` vs `{a, b}` fragment the cache (a miss), never alias it
(a wrong hit); canonical key-sorted encoding is rejected for v1 as bytes
in the size-limited stub with zero correctness benefit. The stub always
appends `?args=…` (one code path); the endpoint tolerates its absence as
`[]` for curl ergonomics. Oversized URLs are a **414** over `maxUrlBytes`
(default 8 KiB — under mainstream proxy request-line caps; the GET analog
of `maxBodyBytes`), and the stub warns in `__DEV__` above ~2 KiB that the
arguments are too large to make a good cache key.

**Endpoint behaviour.** GET is accepted **only** for a cache-marked,
non-stream function; a GET to any other resolved function answers `405` +
`Allow: POST` + `Cache-Control: no-store` (resource-precise — that
target really does support only POST). Methods other than POST/GET are
rejected before symbol resolution and advertise the endpoint's method
universe, `Allow: POST, GET`. The GET path skips the content-type gate and
the body read, then rejoins the POST pipeline unchanged: same
prototype-pollution reviver, same codec revive, same error vocabulary,
and the full `guard` → `input` validator → `timeoutMs` → `onError`
chain. `invalidates` delivery is skipped (mutually exclusive with
`cache`). POST **remains valid for every function**, marked or not — GET
is strictly additive (back-compat, `role: 'client'` builds, and the
cache-busting escape hatch).

**Header emission**, on 2xx only, unless the handler already set
`cache-control` via `rq.responseHeaders` (the per-input dynamic-TTL
escape hatch — the handler override always wins):

| Declaration | Emitted |
|---|---|
| default (`private`) | `Cache-Control: private, max-age=<maxAge>[, stale-while-revalidate=<swr>]` **plus `Vary: Cookie`** |
| `public: true` | `Cache-Control: public, max-age=<maxAge>, s-maxage=<sMaxAge ?? maxAge>[, stale-while-revalidate=<swr>]`, no Vary |

`Vary: Cookie` on private responses makes even the *browser's* cache
revalidate across a logout/login inside one profile. Public responses
emit no Vary because the args-only contract (§5.2a) means nothing else
may vary. **Every non-2xx GET response carries `Cache-Control:
no-store`** — errors, guard rejections, 404s, 414s, 405s — so an
attacker-induced error can never be pinned into a shared cache, and a
redeploy's fresh symbols are never shadowed by cached 404s. The header
value is precomputed once at definition time and stamped on the wrapper
(the `__sigxInvalidates` pattern), so the per-request cost is one header
set.

**Out of scope for v1**, recorded as §7 follow-ups rather than designed
here: ETag/conditional GET (hashing every body doesn't clear the bar
while `max-age` + `stale-while-revalidate` absorbs the traffic, and CDNs
mint ETags themselves), HEAD (405 for now), a per-call freshness flag
(deferred to #315 and since **shipped** there as `.with({ fresh: true })`
— `cache: 'no-cache'` on the stub's fetch), and server-side
memoization of the in-process SSR call path (a different feature that
must not creep in through this one). `serverStream` never qualifies:
structurally it has no options form, and the endpoint guards it anyway.

For how HTTP caching layers with `@sigx/cache`'s `staleTime`, see §6.2 —
they are deliberately two separate channels.

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
   with token headers (CSRF-immune by construction). Cache-marked GET
   reads (§4.1) sit outside this item entirely — they are safe-method
   requests with their own posture, §5.2a.
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

### §5.2a GET reads — the safe-method contract (#354)

Item 2's defenses protect *state changes*. A §4.1 GET read is a safe
method: there is no state change to forge — **if and only if the function
is genuinely side-effect-free**. Declaring `cache` is that promise, and
its inverse must be stated starkly: **a mutating function marked `cache`
re-opens CSRF completely.** `<img src="/_sigx/fn/<symbol>?args=…">` fires
it cross-site, credentialed, with no preflight and no content-type gate —
and additionally lets an attacker *prime caches* with the mutation's
response. The framework cannot detect this; it is the one place the
design trusts the author, and the docs say so in exactly these terms.

What replaces the POST defenses, point by point:

- **Origin.** Browsers send no `Origin` header on same-origin GET
  fetches, so the POST-style `'same-origin'` check would 403 every
  legitimate read. The endpoint therefore applies **verify-when-present
  semantics to GET automatically**, under both `'same-origin'` and
  `'verify-when-present'`: an absent `Origin` is admitted; a present,
  mismatching one (including `Origin: null`) is still 403; allowlists and
  `false` behave as configured. This is sound because the threats
  Origin-checking addresses on POST don't transfer: cross-site *writing*
  is excluded by the side-effect-free contract, and cross-site *reading*
  is blocked by CORS — the endpoint never emits
  `Access-Control-Allow-Origin`, so a cross-site page can trigger a read
  but never observe its bytes.
- **Residual: XS-Leaks.** A cross-site page can still probe timing and
  cache state of a GET read. The mitigation is scoping, not machinery:
  reads that must be unobservable cross-site stay on POST (don't mark
  them). A `Sec-Fetch-Site` hardening knob is a deliberate non-goal for
  v1 — it would also poison shared-cache correctness, since that header
  varies by requesting context.
- **Credential leakage — why `private` is the default.** The classic
  failure is a personalized read cached `public`: a CDN serves user A's
  body to user B. Defense in depth: (a) `private` unless `public: true`
  is written in the source; (b) `Vary: Cookie` on every private cached
  response, so even one browser profile revalidates across a session
  switch; (c) every non-2xx — including 401/403 guard rejections — is
  `no-store`; (d) `public` carries the **args-only contract**: the
  handler's output must not consult `rq.request.headers`, cookies, or
  auth-derived `rq.locals`. The guard still *runs* (it may reject), but
  its identity must not shape a public body. `__DEV__` warns
  heuristically when a public read touches `rq.request`.
- **Cache poisoning.** The cache key is the full URL, and under the
  args-only rule the arguments are the *only* input channel — so every
  input is in the key, and unkeyed-header poisoning is impossible when
  the rule is followed. That is why the rule is stated as a security
  invariant, not a style tip. Deterministic encoding means equivalent
  calls can fragment the cache but never alias to a wrong entry, and the
  non-2xx `no-store` rule keeps attacker-induced errors out of shared
  caches.

### §5.2b Form targets — giving up the content-type layer, deliberately (#312)

Item 2 names three stacked CSRF defenses: POST-only, the non-safelisted
`application/json` content-type, and the `Origin` check. A §6.4 form
target **deliberately removes the middle one** —
`application/x-www-form-urlencoded` and `multipart/form-data` are exactly
the media types a cross-site `<form>` can send credentialed with no
preflight; accepting them is the entire point of the feature. What holds
the line:

- **`Origin`, at full strength.** Unlike §5.2a's GET relaxation, the form
  path relaxes **nothing**: browsers send `Origin` on every POST, form
  submissions included, so under the default `'same-origin'` policy a
  cross-site form POST is 403 and an Origin-less one is too (an
  Origin-less POST is by construction not a mainstream browser's form
  submission). The layer that was designed for exactly this attack is the
  one that remains.
- **The per-fn opt-in bounds the surface.** Only functions the author
  explicitly declared `form: true` accept form bodies at all — a form
  POST to any other symbol is a 415 before the pipeline runs. The
  endpoint never becomes globally form-accepting.
- **The validator is load-bearing.** Form fields are attacker-typable
  strings; the `input` schema is what stands between them and the
  handler. `form` without `input` is a `__DEV__` warning for this reason.

The residual, stated plainly: `form: true` **combined with**
`origin: 'verify-when-present'` or `origin: false` reopens classic CSRF
for those functions — with both the content-type and Origin layers gone,
any site can submit a credentialed mutation. That combination is the
operator's informed choice (a deliberately public form endpoint);
the default policy plus the item-2 caveat about Origin-stripping proxies
is the recommended posture. Error responses on the form path render as
HTML (a no-JS requester can't read JSON), which changes nothing about
masking: §5 item 6 applies verbatim, prod pages carry the generic
message only.

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

Client `break`/`return()` aborts the fetch; `rq.abortSignal` fires server-side.

### 6.2 Server-declared cache directives

The response envelope reserves `$cache`:
`200 {"data": …, "$cache": {"invalidates": [["cart","42"], …]}}`.
`serverFn({ invalidates: (input, result) => [...] })` declares invalidation
**where the data actually changed**; `@sigx/cache` registers an envelope
hook (pack-to-pack, mirroring how cache rides the engine seam) that feeds
`invalidate()` on arrival. Client-side `cache.invalidates` still works;
server-declared is the better default because it cannot drift from the
mutation. TanStack makes the client declare this; Qwik has nothing here.

**Two channels, kept separate.** With §4.1, a read's server-declared
caching has two carriers that must not be conflated: `$cache` is the
*envelope → client-store* channel (invalidation today), while
`Cache-Control` from the read's `cache` option is the *HTTP-layer*
channel. The TTL never comes from `$cache` — a body field that in-process
SSR calls and POST calls never see is the wrong home for a transport
header. A future server-declared client-freshness hint
(`$cache: { staleTime }`) was considered and deferred: the envelope hook
is keyless today (it cannot know which `useData` entry a response feeds),
and inventing that linkage is its own design; the sidecar stays open for
it.

**How the two caches layer.** `@sigx/cache`'s `staleTime` (per `useData`
key, per tab) decides *when to refetch*; HTTP `max-age` (per URL,
browser/CDN) decides *whether that refetch reaches the origin*. They
compose naturally — a revalidation refetch landing inside `max-age` is
served from the browser cache, making duplicate mounts, tab re-opens, and
focus revalidations free. The one confusion to document: if
`maxAge > staleTime`, sigx's revalidation *cannot observe* fresher data
until `max-age` expires — the browser answers from cache. Recommended
defaults: **private** reads keep `maxAge ≤` the read's `staleTime` (HTTP
absorbs duplicates; `staleTime` still governs real freshness) and lean on
`stale-while-revalidate` for the tail; **public** reads — the headline
win, anonymous catalog/content served entirely from the edge — put the
real freshness budget in `sMaxAge` and keep browser `max-age` short.
Note that client-side `invalidate()`/`refresh()` on a GET read may be
answered by the browser cache within `max-age`; the per-call bypass is
`fn.with({ fresh: true })(…)` (#315) — `cache: 'no-cache'` on the stub's
fetch, so the browser revalidates with the origin for that one call.

### 6.3 Single-flight boundary refresh

Boundary records are self-describing — `SSRBoundaryRecord` carries the
component registry key, `props`, and `state`
(`packages/server-renderer/src/boundary.ts`). So a mutation call can name
boundaries to refresh; the server re-renders **just those components**
through the same machinery as the original request (the SSR instance's
plugin set — fresh HTML *and* fresh state via the existing tracking-signal
capture), and the envelope returns them next to `$cache`:

- **Resumed (never-hydrated) boundaries:** DOM swap between the boundary
  element and its marker + record replacement + scope refresh. The
  component updates **without ever loading its chunk** — the server does
  the thinking, the client patches pixels. Qwik cannot do this; Solid's
  single-flight re-runs whole route loaders.
- **Upgraded boundaries:** skip the HTML; write `state` through the live
  signals — fine-grained reactivity patches the DOM.
- Boundaries that a re-render cannot reproduce decline and fall back to
  §6.2 invalidation. A refresh landing mid-upgrade is dropped (the
  upgrade's live state wins).

One request: mutation + fresh UI.

Three corrections from building the mechanism (#313) against the real
code — the shipped design where it deviates from the sketch above:

- **Ids are per-request, so fresh HTML cannot reuse the page's id.** The
  re-render runs a new context whose `<!--$c:N-->` markers would collide
  with the page's (nested components especially). Instead the client
  sends an unused id floor `base`; the render context seeds its counter
  with it (`SSRContextOptions.baseComponentId`); the envelope entry is
  `{for, id, html, state, records}` — `for` names the page boundary being
  replaced, `id` is the fresh render's root id (its marker id in `html`),
  and `records` is the re-render's full boundary-table patch, nested
  boundaries included. The client installs the records, swaps the DOM,
  and retires the old id. Nested-boundary refresh works instead of
  declining.
- **The server is stateless — descriptors come from the client.** Props
  live only in the browser's table, so the request carries
  `{id, component, props}` per boundary (props verbatim in encoded form).
  Descriptors are attacker-controlled; three constraints bound them: the
  fn's `refreshes` allowlist filters by component key, the explicit
  server-side `components` registry must know the key
  (`createBoundaryRefresh` in `@sigx/resume/server` — same explicit-pass
  posture as the fn registry), and the endpoint `guard` has already run.
  The re-render also re-checks its own record: a smuggled `children` prop
  turns it lossy (`refreshable: false`, stamped at initial SSR whenever
  the props snapshot cannot reproduce the render — children/slots/render
  props) and it declines. Declines are **omission**, never errors — the
  mutation already succeeded; declined boundaries converge via `$cache`.
  A component failure during the re-render declines the same way
  (fresh-but-broken must not replace stale-but-consistent).
- **`$boundaries` rides the boundary codec, not the RPC wire codec.**
  `state`/`records` are encoded with the table's own
  `encodeWithHandlers` discipline — the client table already holds
  encoded values, the stub passes the sidecar through untouched (exactly
  like `$cache`), and resume's idempotent `reviveFromServer` decodes at
  the existing read sites.

### 6.4 Zero-JS form actions (#312 — locked design)

A `<form>` whose submit handler calls a server function gets real
`action="/_sigx/fn/<symbol>" method="post"` stamped at build time. The
endpoint goes dual-mode: `application/json` → RPC envelope;
`application/x-www-form-urlencoded`/`multipart/form-data` → FormData
normalized to the fn's single input, the same `input` validator, the same
guard → validate → handler pipeline, then `303` POST-redirect-GET.

- JS loaded: delegation intercepts submit → RPC → single-flight patch (6.3,
  once it exists).
- JS off, failed, or not yet loaded: the native POST works.

The interaction resumability exists to never drop becomes *undroppable* —
it doesn't even need the loader. One `serverFn`, one validator, two
transports. (Qwik City's `routeAction$`/`<Form>` has a progressive story;
the sigx plus is that the same function serves both transports and the
page still ships ≤1 KB of JS.)

**The opt-in is `form: true`, options form only.** The read-side twin
`cache` (§4.1) marks a fn GET-able; `form: true` marks it a **form
target**: the endpoint accepts form content-types for it (and only it —
see the gates below), and the build stamps the `action` attribute for it
(and only it). Options form only, because only it has the single-input
shape FormData can map onto, and restricting to it makes the compiler
enforce that shape. The wrapper stamps `__sigxForm: true` (the
`__sigxGet` capability-mark pattern); the build's detection is stricter
than `cache`'s presence-only rule — a **literal `true`** is required,
because a stamped action pointing at a fn whose runtime mark resolved
false would 415 with no JS on the page to recover. `__DEV__` warns on
`form` + `cache` together (a form target is a mutation; a cacheable read
cannot be one) and on `form` without `input` (the no-JS transport
delivers an attacker-shaped string map straight to the handler — declare
a validator).

**FormData → input.** One flat object, built with `getAll` per field
name: a single value stays the value, repeated names become an array,
`File` entries pass through untouched, and everything else **stays a
string** — Standard Schema coercion (`z.coerce.number()`,
`z.coerce.boolean()`, …) is the documented mapping tool, which is also
what keeps the two transports honest: both run the same validator, so a
shape mismatch fails loudly instead of silently diverging. Field names in
`DANGEROUS_KEYS` are dropped (the JSON reviver posture). No `a[b]`/`a.b`
nesting convention in v1 — flat only. An absent checkbox is an absent
key; an empty file input is a zero-byte `File`; both are the validator's
concern.

**The equivalence contract.** The submit handler should send the same
shape the form fields produce (`Object.fromEntries(new FormData(form))`
or equivalent). The fn cannot tell the transports apart except via
`rq.request`; the JS path is plain RPC, byte-identical to today.

**Round-trip.** Success is a **`303`**: a handler-set `Location` (via the
existing `rq.responseHeaders` seam) wins; otherwise the endpoint redirects
back to the **same-origin-validated `Referer`** (its path + search),
falling back to `/`. A handler that sets a non-3xx status via
`rq.status()` gets it verbatim with no default Location — form-mode
success is a redirect by contract, and anything else is the handler
taking full ownership. Validation failure (and every other error) on the
form path is answered with a minimal, self-contained **HTML** page —
`__DEV__` lists the escaped validator issues; prod is generic — because
the requester by definition has no JS to render a JSON error. The error
shape forks on the **request content-type**, never on the fn: JSON
callers of the same fn keep the JSON envelope and JSON errors
byte-for-byte. The documented first line of no-JS validation UX is the
platform's: `required`, `type=`, `min=`, `pattern=` work with zero JS.
`§6.2 invalidates` does **not** run on the form branch — directives are
wire-only (in-process calls already skip them), a 303 carries no envelope
and no `@sigx/cache` client is listening; the redirected GET re-renders
from source.

**Build stamping.** In the resume extractor's attribute-emission pass: a
`submit` handler on a host `<form>` element whose captured imports
include **exactly one** form-marked serverFn — and whose element carries
no author-written `action` or `method` — gets
`action="{endpoint}/{encodeURIComponent(stableSymbol)}" method="post"`
spliced beside its `data-sigx-on:submit`, plus a **forced**
`data-sigx-pd:submit` when the handler body didn't call
`preventDefault()` itself: the loader cancels the native submit
synchronously only when that attribute is present, and without it a
JS-loaded page would double-submit (RPC *and* native POST). The
**stable** symbol (`<stableId>#<name>`) is used because a printed or
long-cached page must survive redeploys — the endpoint's dual registry
already resolves it. Ambiguity (multiple form-marked captures) and
author-provided `action`/`method` warn at build time and skip the stamp;
zero form-marked captures is silently today's behavior. The serverFn's
symbol crosses plugin boundaries through a public seam —
`resolveServerFn(importer, specifier, exportName)` on the sigx:server
plugin's `api` — not through shared internals. `role: 'client'` builds
never stamp (a live client posts cross-origin, which the Origin check
would 403; declared live clients are JS-required by definition), and
hydrate-mode components don't stamp in v1.

**Deferred from v1**, recorded here so they are scope decisions rather
than oversights: bare-specifier (scan-discovered package) serverFn
imports don't stamp; hydrate-mode forms have no native fallback; an
app-provided error-page hook (`formErrorPage` on the endpoint options) is
the escape hatch for branded no-JS error pages; the single-flight patch
composes when §6.3 ships.

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
- **v1.1**: AsyncLocalStorage ambient request context so SSR-time calls see
  the real request — **shipped** (#309, `runWithServerFnContext`), together
  with the explicit `fn.with({ context })` channel (#352) that needs no ALS
  and so works on every runtime. The document handlers open the scope
  themselves through `__SIGX_SERVERFN_SCOPE__`, so apps wire nothing and dev
  matches production; the runner lives beneath `./server` (not `./node`) so
  WinterCG entries register it by import alone, and degrades to running
  unscoped where `node:async_hooks` is absent. Still open: per-fn guard
  overrides. **Shipped early from
  the #349–#357 review sweep**: `onError` observability hook and
  `timeoutMs` on the endpoint options (post-RFC additive surface — the RFC
  originally promised neither; #349/#350), the `__DEV__` non-JSON-safe
  result warning (the §4 interim guardrail; #351 — **since removed**, the
  revive seam landed in #364), and AbortSignal pass-through via the
  `.with(options)` per-call channel (pulled forward from v2; #353).
- **v2**: `serverStream` → `useStream` (6.1 — **shipped**, #310);
  server-declared cache directives with `@sigx/cache` (6.2 — **shipped**,
  #311); zero-JS forms (6.4 — **design locked**, #312: `form: true`
  opt-in, dual-mode endpoint, §5.2b posture, build-stamped stable-symbol
  actions; deferred from its v1: bare-specifier stamping, hydrate-mode
  fallback, `formErrorPage`); per-call options (**shipped**, #315 —
  `headers` merged over the transport's under the content-type rule, and
  the `fresh` GET-freshness bypass; the `.with(options)` channel itself
  shipped in v1.1 with AbortSignal, #353); GET + cache semantics for
  idempotent reads (**shipped**, #354 — locked design §4.1 + §5.2a;
  follow-ups deliberately deferred from it: ETag/conditional GET, HEAD,
  canonical key-sorted `args` encoding; its per-call freshness bypass
  shipped with #315); rich type-handler
  wire serialization (**shipped**, #364 — the revive side of the serializer
  seam landed with it).
- **v2+**: single-flight boundary refresh (6.3) — **shipped** (#313, three
  PRs): mechanism (`baseComponentId`, `refreshable` stamping,
  `createBoundaryRefresh`, table write accessors); wire (`refreshes`
  option, `renderBoundaries` endpoint option, stub sidecar +
  `__SIGX_SERVERFN_BOUNDARIES__` seam, transform flag + dev parity);
  client apply (status-gated swap/live-write in `@sigx/resume/client`,
  proven end-to-end by examples/resume's smoke: mutation + fresh UI in
  one request, zero component chunks).
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
