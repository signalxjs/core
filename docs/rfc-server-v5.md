# RFC: rfc-server v5 — the 1.0 consolidation: one form, one route, one descriptor

Status: **accepted** (pre-1.0, breaking). Tracking: signalxjs/core#692.
Amends `rfc-server.md` §1.1 (two authoring forms → one), §3 (symbol format,
dual registration), §4 (the envelope gains `v`; 404 vs 409) and N.2/N.3
(stable routes: there is no hashed twin any more); `rfc-server-v4.md` §1.2
(the direct-form paragraph is void — there is no direct form) and §1.3 step 4
(the arity gate is universal). `rfc-server-v3.md`'s mechanism (request-scoped
context, `perRequest`, disposal) is unchanged; only its direct-form examples
are pre-v5 syntax, which its banner says. Pre-1.0, no-compat, the same stance
as every revision before it: one way to do it.
`docs/migrations/1.0-serverfn.md` is the migration.

Everything below is stated against the code at `94cc047`, with `file:line`
evidence. Where this document and the code disagree, the code wins until the
implementation lands, and this document is corrected.

---

## Problem — duplication the freeze would lock in

`rfc-1.0.md` §1.2 makes the `serverFn` / `serverStream` option forms, the
`*.server.ts` convention and the `virtual:sigx-*` modules Tier A at
`v1.0.0-rc.0`. An architecture pass over `@sigx/server` and `@sigx/vite/server`
before that freeze found no missing machinery. It found five places where the
package carries two mechanisms for one job, each one a seam a 1.x consumer
would have to be migrated across later:

1. **Two authoring forms with asymmetric enforcement.** The direct form
   `serverFn(async (rq, ...args) => …)` cannot declare `input`, `authorize`,
   `allowAnonymous`, `cache`, `form`, `invalidates` or `id`; its arity is
   unenforced and its wire arguments reach the body unvalidated (dev-warned
   once per fn, `packages/server/src/index.ts:262-274`). It forces two
   pipeline branches in `createServerFn` (`index.ts:256-323`), three
   `serverStream` overloads discriminated by `input?: undefined`
   (`index.ts:491-567`), and `ServerPolicyOp` carrying both `input?` and
   `args` (`types.ts:67-86`). The README's own guidance is a rule of thumb
   about which side of the asymmetry a function belongs on
   (`packages/server/README.md:104-139`).
2. **Two wire identities per function.** The content-hashed symbol
   `<name>_fn_<hash8>` is the default route; the stable symbol `<id>/<name>`
   is the `useData` key, the `invalidates` identity and the route only under
   `stubSymbols: 'stable'` (`packages/vite/src/server-fn.ts:288`). The
   registry dual-registers both (`server-fn.ts:468-531`), `ServerFnInfo.symbol`
   means a different thing per mode (`types.ts:9-16`), and in-process calls
   carry `symbol: ''` (`index.ts:344`). The hash seed is the raw source slice
   of the call (`server-fn-extract.ts:632`), so a reformat re-mints every
   route.
3. **Nine loose `__sigx*` stamps** on the wrapper (`types.ts:367-428`) are the
   real contract between runtime, transform, endpoint and `useData`. The
   endpoint already defends against inconsistent combinations
   (`server/index.ts:715-728`). And `__sigxName` is always `"handler"` in the
   options form — ES NamedEvaluation names a method after its key — so it
   carries no information there.
4. **Six positional stub arguments** with byte-identity constraints
   (`client/index.ts:234-248`, `server-fn-extract.ts:461-470`) and no room
   for a seventh flag.
5. **Hand-written endpoint wiring.** `resolve: (symbol) => serverFns[symbol]?.() ?? null`
   is copied across five example entries and three adapter scaffolds; only
   the Node adapter has a `functions` option and the `__proto__` guard
   (`node.ts:55-70`).

Plus four smaller gaps: `*.server.ts` build faults (default export, re-export,
options spread, an unexported `serverFn`) only warn and surface as browser
runtime failures, against `rfc-1.0.md` §4.5's posture; `useData`'s fn-ref
fetcher discards `ctx.signal` (`runtime-core/src/use-data.ts:74-83`); the
stub never sets `credentials`; `plugin.ts:29` imports `provideTypeHandlers`
from `sigx/internals` and the package has no #416 pack-contract guard.

---

## §1 Decisions

### 1.1 One authoring form (D1)

The direct form is removed. `serverFn(options)` and `serverStream(options)`
are the only shapes; every function takes exactly one `input` or none. The
arity guard ("more than one wire argument → 400") becomes universal. The
three `serverStream` overloads collapse to one; `ServerStreamInputOptions`
and the multi-argument `ServerStreamOptions<A, T>` are gone.

Why: the direct form's whole value was multi-argument ergonomics, and its
whole cost was that every enforcement the package offers (validation, arity,
per-function access declarations, `id`, `cache`, `form`) was unavailable on
it. A fail-closed runtime with a form that cannot declare access is a
contradiction the README papered over. One form makes `requireAuthorization`
a total check and removes a branch from every transport.

`ServerPolicyOp.args` and `ServerFeatureOp.args` go with it: `op.input` is
the validated input, `undefined` when the definition declares no `input`. A
feature whose operation is a method call passes its argument list *as* the
input.

### 1.2 The handler takes one object (D2)

```ts
handler({ input, rq })                    // serverFn
async function* handler({ input, rq })    // serverStream
```

Chosen on two criteria, judged without regard to churn:

- **DX.** The four usage cases — input + context, input only, context only
  (no input), neither — each cost one placeholder under either positional
  order (`(_rq, input)` or `(_, rq)`). The object costs none.
- **Extensibility.** Positional shapes extend only through `rq`. A typed
  `principal` member (bound to `createServerApp<P>`) or a `signal` alongside
  `input` would be a positional break, so it would wait for 2.0. The object
  absorbs both as new keys in a minor.

Precedent: Remix, SvelteKit and TanStack Start give handlers one object for
the same reasons. Policies `(principal, rq, op)`, middleware `(rq, fn)`,
`perRequest((rq, onDispose) => …)` and `invalidates(input, result)` keep
their positional shapes — each has a dominant bare case that reads better
positionally, and none has a plausible third member.

The cost is braces on every handler, and the no-schema annotation is clunkier
(`({ input }: { input: Foo })`). Wire input without a schema is already the
dev-warned path, so the nudge is in the right direction.

### 1.3 One wire identity (D3)

The stable symbol `<id>/<name>` is the **only** route and the only registry
key. The content hash survives as a **version tag**: the build bakes it into
the stub, the stub sends it with every call, and the endpoint answers `409`
with `code: 'version-skew'` when it differs from the registry's. `stubSymbols`
and dual registration are removed; `role: 'client'` no longer changes a
stub's identity (it still means "stub every environment, emit no registry").

Why: the route, the data key and the invalidation identity were already the
same string on two of three paths; the hashed route existed only for skew
detection, which a version tag provides without a second URL grammar. In
return the in-process transport gains a real identity — `callWith` reads the
wrapper's stamped `__sigxKey` at call time, so middleware and audit logs see
`info.symbol === '<id>/<name>'` on every transport instead of `''`.

The version seed is no longer text. See §4.2.

### 1.4 The stub factory (D4)

```ts
__serverFnStub(key, name, endpoint, version, flags?)   // flags: 1 = GET read, 2 = invalidates
__serverStreamStub(key, name, endpoint, version)
```

Five positionals with a bitmask instead of six with two booleans. The flags
argument is omitted when zero, so unmarked output stays minimal.

### 1.5 One descriptor (D5)

`__sigxKey: string` stays the only cross-package brand: `@sigx/runtime-core`
reads it (`async/key.ts:27-38`), the transform stamps it, `stampServerFnKey`
sets it. The other eight stamps fold into one frozen object:

```ts
fn.__sigx: ServerFnDescriptor  // { kind, invoke, anon, form, read?, invalidates? }
```

created once at definition time. A frozen descriptor cannot carry `read`
without `cacheControl`, so the endpoint's inconsistent-combination defence
(`server/index.ts:715-728`) disappears rather than being re-expressed.

### 1.6 The registry is an option (D6)

`functions: ServerFnRegistry` becomes the primary option on
`ServerFnRequestOptions`, `ServerFnMount` and `createServerFnHandler`, with
`resolve(key)` kept as the escape hatch. Exactly one is required, checked
once at construction (mount / handler creation) with a throw. One shared
resolver owns the own-property + callable guard and reads the entry's
`version`; the `resolve` path yields no version and is never skew-checked.

### 1.7 Transform-time problems are build errors (D7)

Following `rfc-1.0.md` §4.5 for resume, in a `*.server.ts` module these are
errors, not warnings: `export default` of a server function; `export *` and
`export { x } from` (type-only re-exports excepted); a `serverFn`/`serverStream`
call that is not an exported top-level `const`; a spread inside the options
literal (it hides the statically-read `id` / `cache` / `invalidates` / `form`
/ `authorize` / `allowAnonymous`); a non-literal `id`; `form` or
`allowAnonymous` present but not the literal `true`. The inline extractor
already errors on placement (`server-fn-inline.ts:569-582`); the file
extractor shares that check. `virtual:sigx-server-fns` refuses a client
environment and a `role: 'client'` build (`this.error`, the same posture as
`virtual:sigx-app`), and a duplicate key across two files is an error.
`DEFAULT_INCLUDE` gains `**/*.server.mts`, `.js`, `.mjs` — `LANG_BY_EXT`
already parses them.

### 1.8 Ride-alongs (D8)

- `useData`'s default fn-ref fetcher calls `fn.with({ signal: ctx.signal })`
  when the ref exposes `.with`, so a released cell aborts its fetch.
- `ServerFnTransport.credentials?: RequestCredentials` is passed to `fetch`,
  so a cross-origin `endpoint` can carry cookies by choice.
- `provideTypeHandlers` is exported from the `@sigx/runtime-core` root (and
  therefore `sigx`) — the #449 precedent; `packages/server` gets a
  `pack-contract.test.ts` like resume's, plus a case pinning that the
  size-limited client entry imports nothing from `sigx` / `@sigx/runtime-*`.
- The direct-form dev warning is deleted; the "wire input arrived with no
  `input` validator" warning stays, in one wording for fn and stream.

---

## §2 The public types

```ts
// packages/server/src/types.ts
export interface ServerFnHandlerArgs<S> {
    /** VALIDATED input when `input` is declared; the raw single wire
     *  argument otherwise (dev-warned); `undefined` for an input-less fn. */
    input: S;
    /** The request context — the same object policies and middleware see. */
    rq: ServerFnContext;
}

export interface ServerFnDescriptor {
    readonly kind: 'fn' | 'stream';
    /** The full pipeline; transports call it with a live context. */
    readonly invoke: ServerFnInvoke;
    /** `allowAnonymous: true` was declared. */
    readonly anon: boolean;
    /** `form: true` was declared. Always false for streams. */
    readonly form: boolean;
    /** Present iff `cache` was declared: the function is a GET-able read. */
    readonly read?: { readonly cacheControl: string };
    /** Present iff `invalidates` was declared (fn only). */
    readonly invalidates?: (
        input: unknown,
        result: unknown
    ) => ReadonlyArray<InvalidatePattern> | Promise<ReadonlyArray<InvalidatePattern>>;
}

export interface WrappedServerFn {
    readonly __sigx: ServerFnDescriptor;
    /** Build-stamped stable key `<id>/<name>`; absent or `''` when unstamped. */
    __sigxKey?: string;
}

export interface ServerPolicyOp {
    fn: ServerFnInfo;
    /** The VALIDATED input; `undefined` when the definition declares no `input`. */
    input?: unknown;
    resource?: { kind: string; type: string; key: string; method: string };
}

export interface ServerFnRegistryEntry {
    /** Lazy import of the wrapped function. */
    load(): Promise<unknown>;
    /** This build's version tag for the function (hash8 of its normalized
     *  definition). A client that sends a different one gets 409. */
    readonly version: string;
}
/** Key (`<id>/<name>`) → entry. Null-prototype when emitted by the build. */
export type ServerFnRegistry = Record<string, ServerFnRegistryEntry>;
```

```ts
// packages/server/src/index.ts
export interface ServerFnOptions<S, R> {
    id?: string;
    input?: StandardSchemaV1<S>;
    authorize?: ServerPolicy | ServerPolicy[];
    allowAnonymous?: true;
    invalidates?(input: S, result: Awaited<R>): ReadonlyArray<InvalidatePattern> | Promise<ReadonlyArray<InvalidatePattern>>;
    cache?: ServerFnReadCache;
    form?: true;
    handler(args: ServerFnHandlerArgs<S>): R | Promise<R>;
}
export function serverFn<S = void, R = unknown>(
    options: ServerFnOptions<S, R>
): ServerFnCallable<[S] extends [void] ? [] : [S], Awaited<R>>;

export interface ServerStreamOptions<S, T> {
    input?: StandardSchemaV1<S>;
    authorize?: ServerPolicy | ServerPolicy[];
    allowAnonymous?: true;
    handler(args: ServerFnHandlerArgs<S>): AsyncGenerator<T>;
}
export function serverStream<S = void, T = unknown>(
    options: ServerStreamOptions<S, T>
): ServerStreamCallable<[S] extends [void] ? [] : [S], T>;
```

`ServerFnCallable<A, R>` and `ServerStreamCallable<A, T>` keep their shape;
`A` is now always `[]` or `[S]`.

**Inference.** An unannotated destructured handler is still context-sensitive,
so `S` fixes in the first inference pass from `input` (a plain data property)
and `R` from the handler's return in the second — `invalidates` written after
`handler` keeps a typed `result`, as today. With no schema, a parameter
annotation `({ input }: { input: Foo })` is an inference site for `S`. With
neither, `S` takes its default `void` and the callable takes zero arguments
(#451/#454 preserved). One signature, no overloads, the same reason
`index.ts:223-229` gives today. A compile-time test file pins all of it.

```ts
// packages/vite/client.d.ts
declare module 'virtual:sigx-server-fns' {
    /** Key (`<id>/<name>`) → `{ version, load }`; structurally `ServerFnRegistry`.
     *  Pass it as `functions:`. Null-prototype. Server environments only. */
    export const serverFns: Record<string, { readonly version: string; load(): Promise<unknown> }>;
    export const serverFnBase: string;
}
```

---

## §3 The wire

### 3.1 One route

```
POST {base}/{key}          {"args":[input],"v":"<version>"}
GET  {base}/{key}?a0=…&v=<version>          (cache-marked reads, §4.1)
POST {base}/{key}          application/x-www-form-urlencoded | multipart/form-data   (form targets, §6.4)
```

`key` is `<id>/<name>` with its slashes as real path separators (#355/#543);
everything after `base` is the key. The stream transport is a POST with the
same envelope.

### 3.2 The version tag

The version rides **in-band**: `v` in the JSON envelope for POST (fn and
stream), `?v=` for GET, nothing on a form post. Not a request header:

- a custom header needs `Access-Control-Allow-Headers` cooperation for the
  remote-endpoint deployment that `configureServerFn({ endpoint })` exists
  for (N.1), and header-stripping proxies are a documented failure class;
- `?v=` gives every deploy a fresh HTTP cache key for its GET reads — the
  deploy-coupling the hashed route used to provide, now without moving the
  route;
- the endpoint already parses both structures; `decodeReadQuery` provably
  ignores `v` (`fn-url-decode.ts:69,88` match only `^a\d+$` and `args`);
- forms and native clients are correct by construction: no `v`, no check.

Endpoint rule, after the function resolves and the args array is validated
as an array, before the context is built: **present, registry version known,
different → 409**:

```json
{ "error": { "message": "version skew", "status": 409, "code": "version-skew" } }
```

`cache-control: no-store` on a GET, like every non-2xx read. A non-string `v`
is ignored, not a 400. The 409 fires before the prelude, so a skewed client
is not rate-limited by middleware — accepted: it is cheaper than the
prelude, and the version is public in the client bundle anyway.

Stub: 409 with `code: 'version-skew'` maps to the reload hint that a 404
used to carry; the branded error gains `code` so a cache pack or an app can
branch on it. 404 now means only "unknown function" and says so.

### 3.3 The envelope

`{ data?, error?, $cache?, $boundaries? }` is unchanged; `v` is a request
field only. `rfc-1.0.md` §1.2's "not covered" list names the envelope, its
`v` / `$cache` / `$boundaries` fields, the key encoding and the version tag.

---

## §4 The build

### 4.1 Identity

`ExtractedServerFn` carries `key` (`<routeSafeId(id)>/<name>`) and `version`
(hash8). `mintSymbols` becomes `mintIdentity(name, callNode, explicitId, stableId, …)`
and takes the parsed call node rather than its source text. An explicit
`id:` pins both, as before. `api.resolveServerFn` returns `{ key, form }`;
resume's form stamping uses `key` (the `action=` bytes are unchanged — the
stable symbol *is* the key).

### 4.2 The version seed

`version = hash8(`${id}\0${name}\0${normalizeServerFnCall(node)}`)` where
`normalizeServerFnCall` is `JSON.stringify` over the already-parsed
`CallExpression` with a replacer that drops `start` / `end` / `range` / `loc`
/ `raw` and maps `bigint` values to strings (`JSON.stringify` throws on a
BigInt literal's `value`). Comments are absent from the ESTree body, so a
reformat or a comment edit keeps the version; any identifier, literal or
structural change — the handler body, the `input` schema expression, the
`authorize` list — bumps it, which is what "this definition differs" means.
A parser upgrade that reorders node properties bumps every version once;
harmless, both ends ship from one build. One known blind spot, accepted:
dropping `raw` also drops a template element's raw text, so two tagged
templates whose content is uncookable (`cooked: null`) and differs only in
raw spelling share a version. Rejected: regex comment stripping (breaks on
`//` inside strings and templates); an AST printer (none is exposed by vite
or rolldown).

### 4.3 The registry

```js
export const serverFns = {
    __proto__: null,
    ["@acme/api/src/cart.server.ts/addToCart"]: {
        version: "9f3a01cc",
        load: () => import("/src/cart.server.ts").then(m => m["addToCart"])
    }
};
export const serverFnBase = "/_sigx/fn";
```

One record per key. The dev server builds the same shape lazily from its
extraction maps and hands it to `createServerFnHandler({ functions })`, so
dev and prod resolve through one code path.

### 4.4 The stub

```js
import { __serverFnStub, __serverOnly } from '@sigx/server/client';
export const addToCart = __serverFnStub("@acme/api/src/cart.server.ts/addToCart", "addToCart", "/_sigx/fn", "9f3a01cc", 2);
export const getCart   = __serverFnStub("@acme/api/src/cart.server.ts/getCart",   "getCart",   "/_sigx/fn", "5b3c4824", 1);
export const auditLog  = __serverOnly("auditLog", "@acme/api/src/cart.server.ts");
```

`__sigxKey` on the stub is the first argument — never `''` from a build.

---

## §5 Old → new

`@sigx/server`:

| You had | You write now |
|---|---|
| `serverFn(async (rq, id: string) => …)` | `serverFn({ input: Id, handler: async ({ input: id, rq }) => … })` |
| `serverFn(async (rq, sku, qty) => …)` | `serverFn({ input: z.object({ sku, qty }), handler: async ({ input: { sku, qty }, rq }) => … })` |
| `serverFn({ handler: async (rq, input) => … })` | `serverFn({ handler: async ({ input, rq }) => … })` |
| `serverFn({ handler: async (rq) => … })` | `serverFn({ handler: async ({ rq }) => … })` |
| `serverStream(async function* (rq, a, b) { … })` | `serverStream({ input: AB, handler: async function* ({ input: [a, b], rq }) { … } })` |
| `ServerStreamOptions<A, T>` (multi-arg) / `ServerStreamInputOptions<S, T>` | `ServerStreamOptions<S, T>` |
| `authorize: (p, rq, op) => op.args[0] === …` | `op.input` |
| `fn.__sigxFn(rq, info, args)` / `__sigxName` / `__sigxStream` / `__sigxGet` / `__sigxCacheControl` / `__sigxForm` / `__sigxAnon` / `__sigxInvalidates` | `fn.__sigx.invoke` / (gone) / `.kind === 'stream'` / `.read` / `.read.cacheControl` / `.form` / `.anon` / `.invalidates` |
| `info.symbol` — hashed on the wire, `''` in-process | the stable key on every transport (`''` only when unstamped) |
| `handleServerFnRequest(request, { resolve: (s) => serverFns[s]?.() ?? null })` | `handleServerFnRequest(request, { functions: serverFns, base: serverFnBase })` |
| `app.serverFns({ resolve, base })` | `app.serverFns({ functions: serverFns, base: serverFnBase })` |
| `matchesServerFn(request)` with a non-default base | `matchesServerFn(request, serverFnBase)` (unchanged rule; the bun entry was wrong) |
| a 404 with the "version skew" hint | 404 = unknown function; 409 + `code: 'version-skew'` = skew |
| `stampServerFnKey(fn)` (default key from `__sigxName`) | `stampServerFnKey(fn, key)` |
| `__serverFnStub(symbol, name, endpoint, key, get, boundaries)` | `__serverFnStub(key, name, endpoint, version, flags)` |

`@sigx/vite`:

| You had | You write now |
|---|---|
| `sigxServer({ stubSymbols })` (rev 2) | removed — the key is the route |
| `ExtractedServerFn.symbol` / `.stableSymbol` | `.key` / `.version` |
| `mintSymbols(name, implSource, …)` | `mintIdentity(name, callNode, …)` |
| `api.resolveServerFn(...)` → `{ stableSymbol, form }` | `{ key, form }` |
| `serverFns[key]` → `() => Promise<fn>` | `{ version, load }` |
| warnings for default export / re-export / options spread / non-literal `id` | build errors |
| an unexported top-level `const x = serverFn()` in `*.server.ts` silently omitted | build error |
| `**/*.server.{ts,tsx}` | plus `.mts`, `.js`, `.mjs` |

`@sigx/runtime-core` / `sigx`: `provideTypeHandlers` is a root export;
`useData(fn)` / `useData(() => [fn, input])` unchanged in shape, the fetch
now aborts with the cell.

---

## §6 Considered and rejected

- **RPC batching.** Not designed here; the envelope bytes are not Tier A, so
  a batch transport can arrive in 1.x without a break.
- **`next()`-style / around middleware.** Standing non-goal (v4 §9).
- **Per-request middleware cadence.** `authenticate` is memoized per request
  store and `perRequest` covers once-per-request work; changing the cadence
  buys nothing the v4 model does not already offer (v4 §1.1, #628).
- **`useRequest()` in components.** Re-opens the ambient-at-the-call-site
  question v3 settled (v3 §3).
- **Flattening `rq` into the handler object.** `perRequest` values and the
  principal are keyed by `rq.locals` identity; `rq` stays one object.
- **Changing policy / middleware signatures** to the object form. Each has
  a dominant bare positional case (`(p) => p.role === 'admin'`).
- **A request header for the version tag.** §3.2.
- **Renaming `ServerFnInfo.symbol` to `key`.** Tier A and read by
  `@sigx/actors`; documented as the stable key instead.
- **Keeping `ServerPolicyOp.args` for features.** A feature's argument list
  is its input.
- **A text-normalizing hash seed** (regex comment strip). §4.2.

---

## §7 Phasing

| PR | Scope |
|---|---|
| A | this document, `docs/migrations/1.0-serverfn.md`, banners on the superseded RFCs |
| B | `@sigx/server` runtime: D1, D2, D5, the fetcher signal, `provideTypeHandlers` promotion, pack-contract guard |
| C | wire identity across `@sigx/server` + `@sigx/vite` + examples + scaffolds: D3, D4, D6, the registry client-env guard, `credentials` |
| D | build errors (D7) and `DEFAULT_INCLUDE` |
| E | `rfc-1.0.md` §1.2 / §4.9, README and CHANGELOG sweep, the docs-site umbrella issue |

Ecosystem follow-ups filed from B and C, not shimmed in core: `@sigx/actors`
(`op.args` → `op.input`; `__sigx*` reads), lynx's Rspack loader
(`mintSymbols` → `mintIdentity`, `key`/`version`).
