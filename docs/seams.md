# Cross-package seams

sigx packages coordinate **without importing each other**. Packs are siblings —
`@sigx/cache`, `@sigx/resume`, `@sigx/ssr-islands` and `@sigx/server` depend on
the layers below them and never on one another — which is what makes a
first-party pack a drop-in equal of a third-party one rather than a privileged
insider.

Two mechanisms carry that coordination:

- **DI tokens** (`provideAsyncEngine`, `provideTypeHandlers`) when an app
  context is in scope. Typed, app-scoped, testable.
- **`globalThis` seams** when it is not — across a bundle boundary, across the
  server→client boundary, or inside a reactive effect where no instance is
  current. Untyped by nature, so they are listed here.

**This file is the registry.** A global with no entry here is a bug, and so is
a second way to read one — every seam below has exactly one accessor, on
purpose.

That rule is written in hindsight. The map used to exist only by grepping, and
it cost real time: `@sigx/ssr-islands` read `__SIGX_BOUNDARIES__` directly
instead of through `getBoundaryTable()`, and `@sigx/cache` kept its own copy of
the `__SIGX_ASYNC__` accessors. Both were invisible to anyone changing "the"
reader — a decode added to the single accessor would have silently skipped
every island. Both were united in #374.

## Visible or hidden — the two classes (#634)

Every SSR framework puts state on a global, because the server has to hand the
browser something and `window` is the channel: Next.js ships `self.__next_f`,
`__NEXT_DATA__`, `__BUILD_MANIFEST` and `__SSG_MANIFEST`; React DOM's SSR
defines `$RC`/`$RS`/`$RX` from inline scripts; Nuxt has `__NUXT__`; Remix three;
SvelteKit one hashed name; Solid `_$HY`. Qwik and Astro are the mainstream
exception, keeping state in the DOM (`<script type="qwik/json">` inside the
container, `<astro-island>` attributes) instead.

So the question is not whether to have globals — it is which of them a person
opening devtools should ever see. Two classes, and the descriptor says which:

- **Wire seams are ENUMERABLE.** `__SIGX_ASYNC__`, `__SIGX_BOUNDARIES__`,
  `__SIGX_STREAMING_COMPLETE__`, `$SIGX_REPLACE`, `$SIGX_APPEND`. The server
  writes them with a plain assignment from an emitted `<script>`, so their
  descriptor is not ours to choose without changing wire bytes — and they are
  the page's debuggable data cache and bootstrap, exactly what `__NEXT_DATA__`
  and `__NUXT__` are. They stay visible on purpose.
- **Control seams are NON-ENUMERABLE.** Everything else. They are pack-to-pack
  wiring stamped by JavaScript at runtime, nobody reads them off `globalThis`
  by hand, and they have no business in `Object.keys(globalThis)` or a console
  completion list. Their writers use
  `Object.defineProperty(host, NAME, { value, writable: true, configurable: true })`
  — a *new* property defined that way defaults to non-enumerable, so the
  attribute need not be spelled, and `configurable` keeps the disposal
  `delete` paths working.

This costs nothing in compatibility. A third party that stamps a seam with a
plain `globalThis.__SIGX_X__ = v` still works, and the assignment *inherits*
the existing writable data property's descriptor — so it stays hidden too. The
names are unchanged; only their enumerability is.

Note what the hidden class is **not**: it is not a security boundary. Anything
running on the page can still read a non-enumerable property by name. The point
is surface area and legibility, not access control.

> **What the page exposes is app-authored, and unfiltered.** Whatever an app
> returns from a `useData`/`serverFn` fetcher lands verbatim in
> `__SIGX_ASYNC__` under its key, and a claimed component's props and signals
> land in `__SIGX_BOUNDARIES__[id]`. `record.deps` additionally ships canonical
> cache-key strings, which can carry identifiers (`user:42`) even when the
> value does not. The renderer applies key-safety and serializability checks
> (`DANGEROUS_KEYS`, `isSerializable`) and **no sensitivity filter** — a secret
> fetched under a `useData` key is one `window.__SIGX_ASYNC__` away. Nothing
> the framework itself owns goes there: the principal lives on `rq.locals`
> under a non-enumerable `Symbol.for` slot (`server/src/app-config.ts`) that no
> serializer walks, and `@sigx/server-renderer` performs no `globalThis` writes
> at all.

## DI tokens assume ONE module graph

Every `provide*` seam is a `Symbol()` token (`createToken` in
`runtime-core/src/di/token.ts` — deliberately not `Symbol.for`, so versions
can never blur together). Identity therefore lives in **one module graph**: if
two copies of the defining package are live, the writer's token and the
reader's token are different symbols and the provide is simply not found.

That failure used to be silent, because a miss is also what "nothing was
provided" looks like, and every seam treats that as a legitimate default —
`getSSRPlugins()` returns `[]`, hydrate defaults fall back to core's,
`provideTypeHandlers` yields the built-ins. #425 rode that ambiguity into a
production-looking dev server: `createDevRequestHandler` force-inlined the
renderer while the app's `@sigx/*` imports externalized, and resumable pages
rendered with **no boundary table at all** while nothing anywhere complained.

`hasForeignToken(provides, token)` (same module, `sigx/internals`) closes it.
The signal is a provides key carrying the token's description that is not the
token — which reads as a duplicated graph **because of the contract above**,
not as a fact about JavaScript: descriptions are namespaced `sigx:*` and each
is minted in exactly one place, so nothing else legitimately produces one.
(Any code *may* call `Symbol('sigx:ssrPlugins')`; a token declared twice under
one description would trip it too — also worth knowing. Keep descriptions
unique.)

`mergeSSRPlugins` calls it under `__DEV__` and warns. Adopt the same check at
any seam whose miss path silently degrades — on the MISS path only, never
inside `getProvided`, which is the hot injection path where a miss is
ordinarily fine.

## Data seams — payloads the server writes and the client reads

### `__SIGX_ASYNC__`

| | |
|---|---|
| **Written by** | `server-renderer/src/server/state.ts` → `assignmentJs` (`server/serialize.ts`), from `server/state-plugin.ts` — shell script, mid-stream preScripts, and the `onStreamEnd` final drain. Server-side, packs feed it through `ctx.registerSerializedState` (#407), **the only public writer** — useAsync/useStream record their keys through the same `_unflushedAsyncKeys` dirty-set internally. |
| **Read by** | `runtime-core/src/async/restore.ts` — **the only accessor module**, four functions: `peekRestored` (the sole *read*), `invalidateRestored`, `restoredKeys`, `writeBack`. The read/invalidate pair is **public from `@sigx/runtime-core`** (#449) — the seed path for a state-owning pack such as `@sigx/store`; `restoredKeys` and `writeBack` stay on `@sigx/runtime-core/internals`, where `@sigx/cache` imports all four rather than touching the global. |
| **Shape** | Null-prototype object, `key → value`. Values are encoded by `@sigx/serialize`. |
| **Visibility** | Enumerable — a wire seam (see "Visible or hidden"). |

`peekRestored` is therefore also **the** decode point: the codec is applied in
exactly one place for this seam.

The page's data cache for its lifetime: every mount of the same key restores
from it, including after client-side navigation.

**Presence is own-key membership, not truthiness** — `peekRestored` returns
`{ hit, value }` and tests `hasOwnProperty`, so a transferred `null` (or an
`undefined` carried by the codec's `$undef` handler) is a hit, not a miss.
Nothing here needs a presence wrapper.

That lifetime is why **invalidation must sweep this blob, not only a pack's
own store** (#484): a key left here outlives the cell that fetched it, and the
next mount restores it as `ready` without fetching.
`invalidateKeys(patterns)` (`runtime-core/internals`) is the one entry point
that does both halves — refresh the mounted cells, drop the matching keys —
and `restoredKeys()` exists so a pattern can reach keys nothing is mounted on.

The accessors gate on `isLiveClient()`, not `typeof window` (#407): servers
stay inert, browsers are live via the fallback, and a windowless client that
declared itself live (lynx, terminal) may consume an **embedder-installed**
`globalThis.__SIGX_ASYNC__` — the HTML `<script>` is the web transport, not
the contract.

> **⚠️ It is a MIXED store.** The server writes *encoded* values; `writeBack`
> (`restore.ts`) and the cache store write *live* ones back beside them after a
> client fetch. **Anything that transforms this blob must be idempotent** —
> assuming otherwise flattened live `Date`/`Map`/`Set` values to `{}` (#369).
>
> **⚠️ `peekRestored` hands back a value shared with the blob, not a private
> copy.** The codec walk happens to rebuild plain JSON, but a live value
> written back after a client fetch — a `Map`, a `Set`, a class instance,
> anything the codec leaves untouched — comes back by reference, and the
> contract promises nothing better. Because the entry outlives the read (it is
> the page's cache, above), **a pack that hands blob values to reactive state
> must copy them first**: a store that patches the blob's nested objects
> through its own proxy writes every mutation back into the blob, and from
> there into every instance seeded afterwards (#472). This follows from the
> blob's lifetime, not from any one pack.
>
> It is also written **progressively** during streaming SSR, so "decode once at
> load" is not available. Decode is per-read and must stay cheap.
>
> A boundary refresh (`@sigx/resume`'s `createBoundaryRefresh`) carries its
> state in the response envelope + boundary table and deliberately does **not**
> touch this blob — entries a refreshed boundary's packs registered earlier
> stay as-is (#407, decided). Pack seeds that must not outlive their instance
> should consume-once on pickup — `peekRestored` then `invalidateRestored`.
> `@sigx/store`'s `ssrState` offers this as `scope: 'instance'`; its default
> (since 0.11.0, signalxjs/store#71) is to leave the entry in place, so every
> instance in the runtime seeds from it — the consuming default broke every
> store after the first under islands and separately-upgraded resume
> boundaries (#472).

### `__SIGX_BOUNDARIES__`

| | |
|---|---|
| **Written by** | **Server:** `server-renderer/src/server/serialize.ts` → `emitBoundaryTable` (:274) and `boundaryPatchJs` (:306). **Client:** `installBoundaryRecords` (`client/scheduler.ts:120`) and `removeBoundaryRecord` (:133) — a refresh envelope's `records` patch enters the table exactly as a streamed assignment would; both are public via `client/index.ts` and used by `resume/src/client/refresh.ts`. |
| **Read by** | `server-renderer/src/client/scheduler.ts` — `getBoundaryTable` (:97) / `getBoundaryRecord` (:108). Together with the two writers above these are **the only four accessors**. `@sigx/ssr-islands` (`client/island-context.ts`) and `@sigx/resume` (`client/scope.ts`) both go through them. |
| **Shape** | `id → SSRBoundaryRecord { props, state, … }` |
| **Visibility** | Enumerable — a wire seam (see "Visible or hidden"). |

Per-boundary props and signal snapshots for selective hydration and resume.
Islands derives a filtered `IslandInfo` view and memoizes it in
`_cachedIslandData` (invalidated by `invalidateIslandCache`); the core accessor
does not memoize.

> **Decode does NOT happen at the accessor.** `getBoundaryTable` and
> `seedBoundaryState` both sit in the **eager** scheduler bundle, whose
> size-limit entry carries no ignore list precisely to guarantee no runtime
> reaches the eager path — the codec would cost ~750 B of a 3 KB budget. The
> eager path reads only *metadata* (`hydrate`, `media`, `flush`, `chunk`); the
> user values live in `record.props`/`record.state`, so those are decoded with
> `reviveFromServer` in the **lazy** chunks that actually mount components
> (`server-renderer/src/client/hydration-core.ts`, `resume/src/client/`).
> Adding a decode to the accessor would trade a size guard for convenience.

## Bootstrap seams — functions the server defines for its own emitted scripts

Neither payloads nor pack hand-offs: the renderer defines these once, then
every later `<script>` it streams calls them. They cross the server→browser
boundary like the data seams and are enumerable for the same reason.

### `$SIGX_REPLACE`

| | |
|---|---|
| **Defined by** | `server-renderer/src/server/streaming.ts:23` (`generateStreamingScript`), emitted from `ssr.ts` |
| **Called by** | the per-boundary replacement scripts the same module generates (:78) |
| **Contract** | `(id: number, html: string) => void` — swaps the `data-async-placeholder` div for resolved HTML, then dispatches a bubbling `sigx:async-ready` CustomEvent carrying `detail.id`; `client/scheduler.ts` listens for it |

### `$SIGX_APPEND`

| | |
|---|---|
| **Defined by** | `server-renderer/src/server/streaming.ts:47` (`generateAppendBootstrap`), emitted from `ssr.ts` |
| **Called by** | the per-token append scripts (`generateAppendScript`, :61), produced by `server/render-core.ts` |
| **Contract** | `(id: number, text: string) => void` — appends a streamed text token (`useStream`) into its placeholder |

Both take their payload through `escapeJsonForScript`, which escapes `<`, `>`,
U+2028 and U+2029 but **not** `&` — correct for `<script>` text context, which
is the only context either is emitted into. Neither value may be reflected into
an attribute context without additional escaping.

## Control seams — one package handing another a capability

Direction matters and is easy to get backwards: the **stamper** is usually the
package being extended, and the **caller** is the one with no import path to it.

### `__SIGX_SERVERFN_CACHE__`

| | |
|---|---|
| **Stamped by** | `cache/src/index.ts:119` at plugin install (non-enumerable; disposal deletes it at :129) |
| **Called by** | `server/src/client/index.ts:193` when a response carries `$cache` |
| **Contract** | `(directives: { invalidates?: ReadonlyArray<string \| readonly unknown[]> }) => void` |

Server-declared cache directives (rfc-server §6.2) reach the cache pack with no
import in either direction. A throwing hook never breaks the RPC result.

### `__SIGX_SERVERFN_BOUNDARIES__`

| | |
|---|---|
| **Stamped by** | `@sigx/resume/client` at module init (lands with #313 part 3 — until then the seam is unstamped and the stub no-ops) |
| **Called by** | `server/src/client/index.ts` — `collect()` before an `invalidates`-flagged POST, `apply(entries, seq)` when the response carries `$boundaries` |
| **Contract** | `{ collect(): { base: number; refresh: unknown[] } \| null \| undefined; apply(entries: unknown[], seq: number): void }` — both synchronous-shaped, both throw-swallowed by the caller |

Single-flight boundary refresh (rfc-server §6.3): the stub inventories the
page's refreshable boundaries on the way out and hands fresh
`{for, id, html, state, records}` entries back to the resume pack on the way
in, with no import in either direction. `seq` is the call's dispatch order —
the pack uses it to drop stale overwrites from out-of-order responses.
Entries ride the BOUNDARY codec (table-encoded), not the RPC wire codec —
the stub never decodes them. Missing seam ⇒ no sidecar is sent and `apply`
is never called; a throwing hook never breaks the RPC result.

### `__SIGX_SERVERFN_CODEC__`

| | |
|---|---|
| **Stamped by** | `serverPlugin({ types })` / `registerWireTypeHandlers` (`@sigx/server/plugin:61`) — or the app directly |
| **Read by** | `server/src/wire-codec.ts:29`. Also read by its own writer (`plugin.ts:51-52`): registration is a read-modify-write, so the accessor pair lives in two modules. |
| **Contract** | `TypeHandler[]` (see `@sigx/serialize`) — consulted **before** the built-ins. Registration through `registerWireTypeHandlers` is **tag-keyed**: a handler whose `tag` is already present replaces it (idempotent under per-request server-app installs); tag-less handlers append once by identity |

Keeps `@sigx/server/client` able to revive app types without importing them.
Unlike `__SIGX_TYPE_HANDLERS__`, this IS stamped on the server too: the wire
codec has no DI read path (stubs and endpoint are dependency-free by
contract) and the endpoint runs app-less. Tags are already a process-global
vocabulary on the wire, so the cross-app collision the browser-only rule
guards against does not apply — same-tag registration converges instead of
colliding. `serverPlugin({ types })` stamps this AND calls
`provideTypeHandlers` — one registration covers every boundary (#411).

### `__SIGX_TYPE_HANDLERS__`

| | |
|---|---|
| **Stamped by** | `provideTypeHandlers` (`runtime-core/src/ssr-serialize.ts`), browser only |
| **Read by** | `runtime-core/src/async/restore.ts` (`peekRestored`), the boundary decode sites |
| **Contract** | `TypeHandler[]` (see `@sigx/serialize`) — consulted **before** the built-ins |

The client-side half of the per-app handler registry. The DI token
(`TYPE_HANDLER_TOKEN`) stays authoritative on the server, where the render has
an app context; the read paths have none — `peekRestored` runs inside a
reactive effect, and the boundary readers live in packs with no instance in
scope. Since the blob these decode is itself a page global, a page-global
decoder matches its scope. Packs call `provideTypeHandlers` once and get both.

Not stamped on the server: a process-wide list would let two apps' handlers
collide across requests.

One-stop registration: `serverPlugin({ types })` from `@sigx/server/plugin`
calls `provideTypeHandlers` AND stamps the RPC wire codec
(`__SIGX_SERVERFN_CODEC__`) from a single `TypeHandler[]` (#411).

### `__SIGX_SERVERFN_CONTEXT__`

| | |
|---|---|
| **Stamped by** | `runWithServerFnContext` (`@sigx/server/node`), on every scope entry |
| **Read by** | `server/src/context.ts` — `resolveInProcessContext` |
| **Contract** | `() => Request \| Partial<ServerFnContext> \| undefined` |

The ambient request for in-process (SSR-time) server-function calls
(rfc-server §7, #309). Since #494 a scope always resolves to a
`Partial<ServerFnContext>` carrying `locals` — never a bare `Request` — because
that object IS the per-request store every call in the flow shares
(rfc-server-v3 §2.3). The wider contract stands: an app may still stamp a
resolver returning a bare `Request`. A global rather than a module variable because `.` and
`./node` are separate dist entries, and in dev the Vite module runner and Node
can hold two copies of the same module — the same hazard that makes
`ServerFnError` a brand check rather than `instanceof`.

### `__SIGX_SERVERFN_SCOPE__`

| | |
|---|---|
| **Stamped by** | `server/src/scope.ts`, at IMPORT (every server entry pulls it) |
| **Called by** | `server-renderer/src/server/serverfn-scope.ts` — both document handlers |
| **Contract** | `{ run<T>(source: Request \| IncomingMessage \| Partial<ServerFnContext>, fn: () => T \| Promise<T>): T \| Promise<T>; keepAlive?(until: Promise<unknown>): void }` |

The other half of the pair above: `__SIGX_SERVERFN_CONTEXT__` says what the
ambient request IS, this one OPENS the scope that sets it. The handlers wrap
each render in `run()`, so a `serverFn` called during SSR reads the real
request with no wiring in the app.

`keepAlive` (rfc-server-v3 §2.6, phase 5, #571) extends the CURRENT scope's
request-value disposal past `run()`'s settle: the streaming fetch handler
calls it — from inside `run()`, before returning its Response — with a
promise resolved on body close/error/cancel, so disposal fires at
end-of-body instead of at the shell. Calls accumulate per store; disposal
waits for all of them. **OPTIONAL on both sides**: an older `@sigx/server`
stamps a seam without it and a newer renderer feature-detects (that pairing
degrades to pre-disposal behavior — supported); the newer stamp also patches
`keepAlive` onto an already-stamped seam object, covering dev's dual-module
copies. Outside any scope, or with no ALS store, `keepAlive` is a silent
no-op.

Stamped at import rather than on first scope, because the renderer has to know
it can open one BEFORE any scope exists. **Absence is a supported state** —
with no scope registered the handlers call straight through, so
AsyncLocalStorage stays never-required (rfc-ssr-platform §2.3) and an app
without `@sigx/server` pays nothing.

A nested `run()` for the SAME request — same URL + method, protocol excluded —
MERGES into the enclosing scope instead of replacing it (#495): the inner
source's fields win where supplied and the enclosing `locals` stays the request
store, so the documented `runWithServerFnContext({ request, locals }, …)`
pre-seed survives the handler opening its own scope around the render. A
different request opens a fresh store with a once-per-process `__DEV__` notice.

Re-stamped on every scope entry, not just the first: anything may clobber or
delete a global, and a store nothing can read is a worse failure than a
redundant assignment. A throwing resolver is swallowed — the detached
context's descriptive error is more actionable than a leaked internal one.
`fn.with({ context })` wins over whatever is ambient.

`run` returns `T | Promise<T>`, not `Promise<T>`: the store is resolved through
a dynamic `import('node:async_hooks')`, so only the FIRST entry is
asynchronous — every one after it enters the scope synchronously and hands
back whatever `fn` returned (#544). Await the result, as all three call sites
do; treating it as a thenable without awaiting (`.then(…)` straight on it) is
what breaks.

### `__SIGX_SERVER_APP__`

| | |
|---|---|
| **Stamped by** | `createServerApp()` (`@sigx/server/server`) — the app's server-app module, at evaluation; `/testing`'s `stubServerApp` in tests. Last-wins (HMR-safe), `dispose()` releases only its own stamp. **The config is frozen on the way in** (#634) — see below |
| **Read by** | `server/src/app-config.ts` — `resolveServerAppConfig()`, the only accessor; consulted lazily per call by the endpoint, by `invoke`, and by every `ServerFeatureContext` member (#625) |
| **Contract** | `{ middleware?, authenticate?, authorize?, posture?, codec?, claimedBases? }` (`ServerAppConfig`) |

The app-wide server pipeline (rfc-server-v4 §2/#607): middleware,
authentication, the default authorization policy, the endpoint posture, and
the principal codec. The registry's first **fail-closed control seam** —
each reader maps absence to its layer's deny: middleware absent is an empty
chain, authenticator absent is a `null` principal (the identity gate then
401s everything not `allowAnonymous`), default policy absent is
`requireAuthenticated`. **A miss may only ever remove permission, never add
it.** Rule 4 (swallow far-side throws) deliberately does NOT apply: a
throwing policy or authenticator is a deny or an error, never swallowed —
swallowing here would be the fail-open the class forbids.

Since #625 this seam also backs the **endpoint-family seam**
(`ServerFeatureContext`, rfc-server-v4 §3.2): `serverFeature()` reads it per
call, which is what lets a second family — `@sigx/actors` — run the pipeline
from call sites that hold a request context but no platform value. Same
fail-closed mapping, because they are the same functions.

`claimedBases` is the one entry that is **not** a control: it is mount-time
namespace bookkeeping (#543 — everything after the base IS the symbol), so
its miss is a no-op rather than a deny. It lives on the config so
`createServerApp`'s own mounts and a feature's mounts claim against ONE
registry; scope stays per-app, since stamping a new app brings a fresh
array.

**`stampServerAppConfig` freezes the config** (#634). Replacing the app
wholesale stays legal — HMR and `stubServerApp` need it, and it already
dev-warns — but swapping a member in place,
`globalThis.__SIGX_SERVER_APP__.authorize = () => true`, warned nothing and
silently failed **open**, which is exactly what a fail-closed seam must not
permit. It now throws. `claimedBases` is pre-seeded to `[]` *before* the
freeze, because `claimAppBase` does `??=` on it: with the array present that
assignment short-circuits and never writes, and `Object.freeze` is shallow so
`push` still works. The seeding is guarded on `Object.isFrozen`, since a
restore stamp hands back a config this function already froze.

Consequence for callers: `resolveServerAppConfig()` returns a **frozen**
object. A test that swapped `authorize` between cases on a stamped config must
re-stamp through `stubServerApp` instead.

(`__SIGX_GUARDS_CHECKED__`, the previous holder of this section, retired
with rfc-server-v4: the fail-closed runtime closed the unanalyzed-module gap
it mitigated — an unanalyzed `*.server.ts` now denies instead of running
open — so the build stamps nothing and the runtime reads nothing.)

### `__SIGX_LIVE_CLIENT__`

| | |
|---|---|
| **Stamped by** | `declareLiveClient()` (`runtime-core/src/async/environment.ts:38`) — non-web platform-identity modules (lynx, terminal) |
| **Read by** | `server/src/index.ts:458` (`assertNotLiveClient`) and `server/src/plugin.ts:109`. **Not** by `environment.ts`, which only writes it: `isLiveClient()` reads a module-local `declared`, deliberately, so the `typeof window` fallback can stay unstamped. |
| **Contract** | `boolean` — `true` declares a live client; an explicit `declareLiveClient(false)` stamps `false` as a not-live override (readers compare `=== true`) |

Marks a runtime with no HTML page. A `serverFn` body reaching a live client is
an unextracted call and throws. `@sigx/runtime-dom/platform` must **not** stamp
it.

### `__SIGX_STREAMING_COMPLETE__`

| | |
|---|---|
| **Stamped by** | `completionScript()` (`server-renderer/src/server/serialize.ts`) — **the one emitter**, called from `document.ts` and both streaming paths in `ssr.ts` |
| **Read by** | **Nothing in `packages/**/src`** — this is an APP-FACING contract, and the only in-repo consumers are the HTML assertions in `scripts/deploy-smoke/assertions.mjs` and `packages/server-renderer/scripts/edge-smoke.mjs` |
| **Contract** | `true`, plus `window.dispatchEvent(new Event('sigx:ready'))` |
| **Visibility** | Enumerable — a wire seam (see "Visible or hidden"). |

The `sigx:ready` event is the half most apps should use; the flag exists for
code that starts running *after* the event already fired. It was three
byte-identical copies of the same emitted literal until #634 — a drift hazard
on a string two smoke suites assert verbatim — and is now a single function.

### `__SIGX_DEVTOOLS_HOOK__`

| | |
|---|---|
| **Stamped by** | the devtools extension |
| **Read by** | `reactivity/src/devtools-hook.ts` |
| **Contract** | `DevtoolsHook \| undefined` (the type is exported from `@sigx/reactivity/internals`) |

The one seam with a `declare global` (`devtools-hook.ts`): it is read by bare
global reference, dev-only, and stamped from OUTSIDE the package graph (a
browser extension), so an ambient declaration is the honest shape. Caveat:
that ambient ships in the package's dts and lands in every dependent's global
scope — acceptable for one dev-only seam, not a pattern to copy.

## Adding a seam

Prefer a DI token. Reach for a global only when there is genuinely no import
path — a dependency-free entry, a cross-bundle hand-off, or a call site with no
app context. Then:

1. Add a row here: name, direction, writer, reader, contract, data or control.
2. Type the contract at **both** ends as a **named structural type at the
   single accessor** (`type FooSeam = { __SIGX_FOO__?: … }`), never a bare
   `as any` and never a `declare global` (the ambient would leak into every
   dependent's global scope via the shipped dts — the devtools hook is the
   documented exception). This row's Contract line is the canonical shape
   both ends copy; the two ends cannot share an import — a type-only import
   across the gap is a dependency edge by another name.
3. Make a missing seam a no-op, never a throw — the reader must work with the
   other package absent. **Exception: a fail-closed control seam** — one
   whose absence must *deny a capability rather than grant one*
   (`__SIGX_SERVER_APP__` is the first). Its accessor still never throws on
   a miss — it returns `undefined`, and each reader maps absence to its
   layer's deny. The invariant is directional: **a miss may only ever remove
   permission, never add it.** A seam whose miss would grant remains
   forbidden.
4. Swallow throws from the far side. A pack bug must not break the caller.
   (Fail-closed control seams invert this too, deliberately: a throwing
   policy is a deny or an error, never swallowed.)
5. **Define a control seam NON-ENUMERABLE** (#634) — the writer uses
   `Object.defineProperty(host, NAME, { value, writable: true, configurable: true, enumerable: false })`.
   Only a **wire** seam (one the server emits into HTML with a plain
   assignment) stays enumerable, and then only because its descriptor is fixed
   by the emitted bytes.

   **Spell `enumerable: false`, even though it is the default for a new
   property.** `defineProperty` with a *partial* descriptor preserves an
   existing property's attributes, so if anything created the name by plain
   assignment first — dev HMR's older module copy, a pack, the app — omitting
   it silently leaves the seam enumerable forever. For the same reason, a
   writer that skips work when the seam already exists (first-stamp-wins, as
   `__SIGX_SERVERFN_SCOPE__` and `__SIGX_SERVERFN_BOUNDARIES__` do) must still
   fix the descriptor on that path: keep the existing value, redefine the
   property.

   **A re-asserting writer must `defineProperty` every time**, not latch and
   fall back to assignment. `__SIGX_SERVERFN_CONTEXT__` re-stamps on every
   scope entry precisely because anything may clobber or *delete* the seam —
   and a plain assignment restores the value while re-creating the property
   enumerable, so the repair path would be the one that un-hides it. The cost
   was measured before the rule was written: ~512 ns versus ~1.5 ns for an
   assignment, which is 0.27% of the cheapest request in `bench:micro`. Below
   noise; do not trade the guarantee for it.

## Appendix: private symbol-keyed globals

Not seams — nothing across a package boundary reads them — but they *are*
`globalThis` state, and this file is meant to be the whole map. They use
`Symbol.for('sigx.*')` rather than a string key for the same reason the seams
above exist at all: two copies of a module must land on one slot. A registry
symbol is invisible to `Object.keys` and to devtools completion by
construction.

| Key | Site | Purpose |
|---|---|---|
| `Symbol.for('sigx.serverfn.unconfiguredHint')` | `server/src/app-config.ts:190` | Once-per-process dev hint latch. Not module-local, or dev's two module copies would each fire a hint whose text claims it fires once. |
| `Symbol.for('sigx.serverfn.warnedNestedRequest')` | `server/src/scope.ts:235` | Same, for the nested-request notice. |

Related, and *not* on `globalThis` — the same discipline applied to a host
object, listed so a search for "where does sigx keep hidden state" finds them:
`Symbol.for('sigx.serverfn.principal')` and
`Symbol.for('sigx.serverfn.requestValues'|'…requestDisposal')` on `rq.locals`
(`server/src/app-config.ts:99`, `server/src/per-request.ts:46,52`),
`Symbol.for('sigx.cloudflare.devPlatform')` on the Vite dev server
(`cloudflare/src/dev.ts:20`), and `Symbol.for('sigx.directives')` on DOM
elements (`runtime-dom/src/directives.ts:59`).

One more global escapes this registry by design: `@sigx/vite`'s auto-import
codegen (`vite/src/cli.ts:267`) writes **user-configured** prefix names onto
`globalThis`. The names come from app config, so they cannot be enumerated
here — but an app that sees an unexpected global should check its own
auto-import prefixes before filing a bug against a seam.
