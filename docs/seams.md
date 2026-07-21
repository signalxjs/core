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

**This file is the registry.** A global with no entry here is a bug. The map
used to exist only by grepping, and that cost real time: `@sigx/ssr-islands`
reads `__SIGX_BOUNDARIES__` directly rather than through
`getBoundaryTable()`, and a change to the "one" accessor silently missed it.

## Data seams — payloads the server writes and the client reads

### `__SIGX_ASYNC__`

| | |
|---|---|
| **Written by** | `server-renderer/src/server/state.ts` → `assignmentJs` (`server/serialize.ts:148`), from `server/state-plugin.ts` — shell script and mid-stream |
| **Read by** | `runtime-core/src/async/restore.ts` (`peekRestored`), `cache/src/store.ts` (`peekBlob`) |
| **Shape** | Null-prototype object, `key → value`. Values are encoded by `@sigx/serialize`. |

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
| **Read by** | `server-renderer/src/client/scheduler.ts:90` (`getBoundaryTable`/`getBoundaryRecord`), `ssr-islands/src/client/island-context.ts:50` (**direct read — bypasses the accessor**), `resume/src/client/scope.ts:76,102` (via `getBoundaryRecord`) |
| **Shape** | `id → SSRBoundaryRecord { props, state, … }` |

Per-boundary props and signal snapshots for selective hydration and resume.
Islands caches its view in `_cachedIslandData` and invalidates on patch; the
core accessor does not memoize.

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
