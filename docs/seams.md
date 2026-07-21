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

## Data seams — payloads the server writes and the client reads

### `__SIGX_ASYNC__`

| | |
|---|---|
| **Written by** | `server-renderer/src/server/state.ts` → `assignmentJs` (`server/serialize.ts:148`), from `server/state-plugin.ts` — shell script and mid-stream |
| **Read by** | `runtime-core/src/async/restore.ts` — `peekRestored`, **the only accessor**. `@sigx/cache` imports it (plus `writeBack`/`invalidateRestored`) from `@sigx/runtime-core/internals` rather than touching the global. |
| **Shape** | Null-prototype object, `key → value`. Values are encoded by `@sigx/serialize`. |

`peekRestored` is therefore also **the** decode point: the codec is applied in
exactly one place for this seam.

The page's data cache for its lifetime: every mount of the same key restores
from it, including after client-side navigation.

> **⚠️ It is a MIXED store.** The server writes *encoded* values; `writeBack`
> (`restore.ts`) and the cache store write *live* ones back beside them after a
> client fetch. **Anything that transforms this blob must be idempotent** —
> assuming otherwise flattened live `Date`/`Map`/`Set` values to `{}` (#369).
>
> It is also written **progressively** during streaming SSR, so "decode once at
> load" is not available. Decode is per-read and must stay cheap.

### `__SIGX_BOUNDARIES__`

| | |
|---|---|
| **Written by** | `server-renderer/src/server/serialize.ts` → `emitBoundaryTable` (:209) and `boundaryPatchJs` (:241) |
| **Read by** | `server-renderer/src/client/scheduler.ts:90` — `getBoundaryTable`/`getBoundaryRecord`, **the only accessor**. `@sigx/ssr-islands` (`client/island-context.ts`) and `@sigx/resume` (`client/scope.ts`) both go through it. |
| **Shape** | `id → SSRBoundaryRecord { props, state, … }` |

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

## Control seams — one package handing another a capability

Direction matters and is easy to get backwards: the **stamper** is usually the
package being extended, and the **caller** is the one with no import path to it.

### `__SIGX_SERVERFN_CACHE__`

| | |
|---|---|
| **Stamped by** | `cache/src/index.ts:86` at plugin install |
| **Called by** | `server/src/client/index.ts` when a response carries `$cache` |
| **Contract** | `(directives: { invalidates?: ReadonlyArray<string \| readonly unknown[]> }) => void` |

Server-declared cache directives (rfc-server §6.2) reach the cache pack with no
import in either direction. A throwing hook never breaks the RPC result.

### `__SIGX_SERVERFN_BOUNDARIES__`

| | |
|---|---|
| **Stamped by** | `resume/src/client/refresh.ts` at module init (`@sigx/resume/client`) |
| **Called by** | `server/src/client/index.ts` — `collect()` before a `refreshes`-flagged POST, `apply(entries, seq)` when the response carries `$boundaries` |
| **Contract** | `{ collect(): { base: number; refresh: unknown[] } \| null; apply(entries: unknown[], seq: number): void }` — both synchronous-shaped, both throw-swallowed by the caller |

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
| **Stamped by** | the app or a pack, for custom classes |
| **Read by** | `server/src/wire-codec.ts` |
| **Contract** | `TypeHandler[]` (see `@sigx/serialize`) — consulted **before** the built-ins |

Keeps `@sigx/server/client` able to revive app types without importing them.

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

### `__SIGX_SERVERFN_CONTEXT__`

| | |
|---|---|
| **Stamped by** | `runWithServerFnContext` (`@sigx/server/node`), on every scope entry |
| **Read by** | `server/src/context.ts` — `resolveInProcessContext` |
| **Contract** | `() => Request \| Partial<ServerFnContext> \| undefined` |

The ambient request for in-process (SSR-time) server-function calls
(rfc-server §7, #309). A global rather than a module variable because `.` and
`./node` are separate dist entries, and in dev the Vite module runner and Node
can hold two copies of the same module — the same hazard that makes
`ServerFnError` a brand check rather than `instanceof`.

### `__SIGX_SERVERFN_SCOPE__`

| | |
|---|---|
| **Stamped by** | `server/src/scope.ts`, at IMPORT (every server entry pulls it) |
| **Called by** | `server-renderer/src/server/serverfn-scope.ts` — both document handlers |
| **Contract** | `{ run<T>(source: Request \| IncomingMessage \| Partial<ServerFnContext>, fn: () => T \| Promise<T>): Promise<T> }` |

The other half of the pair above: `__SIGX_SERVERFN_CONTEXT__` says what the
ambient request IS, this one OPENS the scope that sets it. The handlers wrap
each render in `run()`, so a `serverFn` called during SSR reads the real
request with no wiring in the app.

Stamped at import rather than on first scope, because the renderer has to know
it can open one BEFORE any scope exists. **Absence is a supported state** —
with no scope registered the handlers call straight through, so
AsyncLocalStorage stays never-required (rfc-ssr-platform §2.3) and an app
without `@sigx/server` pays nothing.

Re-stamped on every scope entry, not just the first: anything may clobber or
delete a global, and a store nothing can read is a worse failure than a
redundant assignment. A throwing resolver is swallowed — the detached
context's descriptive error is more actionable than a leaked internal one.
`fn.with({ context })` wins over whatever is ambient.

### `__SIGX_LIVE_CLIENT__`

| | |
|---|---|
| **Stamped by** | `declareLiveClient()` — non-web platform-identity modules (lynx, terminal) |
| **Read by** | `runtime-core/src/async/environment.ts`, `server/src/index.ts` (`assertNotLiveClient`) |
| **Contract** | `true` |

Marks a runtime with no HTML page. A `serverFn` body reaching a live client is
an unextracted call and throws. `@sigx/runtime-dom/platform` must **not** stamp
it.

### `__SIGX_STREAMING_COMPLETE__`

| | |
|---|---|
| **Stamped by** | `server-renderer/src/server/document.ts:44`, `ssr.ts:401,513` — with a `sigx:ready` event |
| **Read by** | client code waiting on a finished document |
| **Contract** | `true`, plus `window.dispatchEvent(new Event('sigx:ready'))` |

### `__SIGX_DEVTOOLS_HOOK__`

| | |
|---|---|
| **Stamped by** | the devtools extension |
| **Read by** | `reactivity/src/devtools-hook.ts` |

## Adding a seam

Prefer a DI token. Reach for a global only when there is genuinely no import
path — a dependency-free entry, a cross-bundle hand-off, or a call site with no
app context. Then:

1. Add a row here: name, direction, writer, reader, contract, data or control.
2. Type the contract at **both** ends, even though the global is untyped.
3. Make a missing seam a no-op, never a throw — the reader must work with the
   other package absent.
4. Swallow throws from the far side. A pack bug must not break the caller.
