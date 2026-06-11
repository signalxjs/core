# RFC: `useAsync` — the unified async-data primitive

Status: **implemented** on the `ssr-next` branch (no-compat: `ssr.load`,
`ssr.stream`, and the signal-name serialization machinery were REMOVED, per
review decision — pre-1.0, one way to do it). Tracking: signalxjs/core#61
(`docs/ssr-review.md`).

## Problem

sigx currently ships four overlapping async primitives, none complete:

| Primitive | Server render | Hydration | Client navigation | State serialized? |
|---|---|---|---|---|
| `ssr.load(fn)` | awaits / streams | no-op | runs | yes — every signal in the component |
| `useAsync(fn)` | **fires the loader, never awaits it, renders the loading state** | refetches | runs | no |
| `Suspense` + `lazy()` | streams | needs preload | works | n/a (code, not data) |
| `ssr.stream()` | streams tokens | restored | runs live | yes |

Beyond the fragmentation, `ssr.load` — the de-facto data primitive — has
structural DX problems:

1. **Inverted data flow.** It returns nothing; data travels by mutating a
   signal inside the callback. The framework never learns what the load
   produced, so state serialization must track *every* signal the component
   creates and ship all of them.
2. **Fragile serialization keys.** Restoration keys are signal names —
   naming is opt-in, requires a type cast today (`(ctx.signal as any)(null,
   'stats')` appears in our own reference example), and unnamed signals fall
   back to positional `$0/$1` keys that silently mismatch when declaration
   order differs between server and client builds.
3. **Fail-quiet hydration.** Without state serialization enabled, hydration
   resets signals to their initial values — server-rendered data silently
   vanishes from the page.
4. **No loading/error/refresh contract.** A rejected load takes the whole
   component to the error fallback; loading branches are hand-rolled; there
   is no way to re-run a load from the client.
5. **No request-level powers.** No dedupe (two components fetching the same
   resource fetch twice), no abort on unmount, no caching policy.

## Proposal

One value-returning primitive — the existing `useAsync` composable,
**upgraded in place** with an optional key that makes it server-transferable.
The rule: *give it a key and it participates in SSR.*

```tsx
import { component, useAsync } from 'sigx';

const Stats = component(() => {
    const stats = useAsync('stats', ({ signal }) => fetchStats({ signal }));
    //    ^ AsyncState<Stats> — T inferred from the fetcher

    return () => {
        if (stats.loading) return <Skeleton />;
        if (stats.error) return <p class="error">{stats.error.message}</p>;
        return <p>⭐ {stats.value.stars} <button onClick={() => stats.refresh()}>↻</button></p>;
    };
});
```

> **Inspectable mock:** `examples/spa-ssr/src/rfc-async-mock/` contains a
> fully-typed mock implementation (`use-async.ts`) plus six real-world
> usage examples (`examples.tsx`) — open them in an editor to explore the
> inference and API ergonomics. They typecheck against the example app's
> tsconfig and are not wired into the running app.

### API surface

```ts
interface AsyncFetcherContext {
    /** Aborted when the component unmounts or refresh() supersedes the run */
    signal: AbortSignal;
}

interface AsyncOptions {
    /**
     * Throw the fetch error during render instead of exposing it on
     * `.error` — routes it to the nearest error boundary / component
     * error fallback. Default: false.
     */
    throwOnError?: boolean;

    /**
     * Run the fetcher on the server. Default: true. `server: false` makes
     * the query client-only (the SSR output renders the loading branch and
     * the client fetches after hydration) — the correct semantics for
     * browser-dependent resources, replacing useAsync.
     */
    server?: boolean;
}

/** Reactive — reads inside a render fn subscribe like any signal. */
interface AsyncState<T> {
    readonly value: T | undefined;
    readonly loading: boolean;
    readonly error: Error | null;
    /** Re-run the fetcher (client). Aborts a run already in flight. */
    refresh(): Promise<void>;
}

// Standalone composable, exported from 'sigx':
function useAsync<T>(
    key: string,
    fetcher: (ctx: AsyncFetcherContext) => Promise<T>,
    opts?: AsyncOptions
): AsyncState<T>;
```

Decided shape (user-confirmed): **functional `useAsync`**, matching the
existing composable convention (`useHead`, `useRouter`, DI tokens). It must
be called synchronously during setup — the same rule every composable
already has; it throws a clear error otherwise.

Naming history: `ctx.query` (context method) was dropped for the composable
convention; `useQuery`/`useResource` were dropped because "query" connotes
datastores and collides with the TanStack ecosystem, while "resource" added
a second vocabulary. `useAsync` won because it describes the act AND it
unifies: the broken composable of the same name becomes the real primitive —
four async primitives collapse to three with zero migration churn.

### Semantics

| Environment | Behavior |
|---|---|
| Server, blocking/string | Fetcher awaited inline (internally registers like `ssr.load`, so all existing plugin hooks — `handleAsyncSetup` etc. — apply unchanged) |
| Server, streaming | Component renders its loading branch into the standard placeholder; replaced via `$SIGX_REPLACE` when the fetch resolves — existing machinery |
| Server, any mode | Resolved value recorded under the **explicit key** for serialization |
| Hydration, state present | `value` restored, `loading` starts `false`, fetcher **not** run |
| Hydration, state absent | **Refetches** (fail-safe; today's `ssr.load` silently blanks — fail-quiet) |
| Client navigation | Fetcher runs; `loading`/`error` reactive; in-flight run aborted on unmount |

**Request-level dedupe.** The query cache is request-global, keyed by the
user's key (`SSRContext._queryCache: Map<string, Promise<unknown>>`; a
page-scoped map on the client). Two components issuing `query('user:1', …)`
in one request share one fetch and one serialized entry. Consequence (by
design, same contract as SWR/TanStack Query): **keys identify the data, not
the component** — dynamic data needs the identity in the key
(`` `user:${props.id}` ``). Dev-mode warning when the same key is registered
with observably different fetcher sources is an open question (§ Open
questions).

### Wire format

A separate blob from component-state serialization, keyed by query key (no
component IDs involved — immune to id drift between renders):

```html
<script>window.__SIGX_ASYNC__=Object.assign(window.__SIGX_ASYNC__||{},{"stats":{...},"user:1":{...}});</script>
```

- Emitted by `stateSerializationPlugin` (extended) — automatic under
  `renderDocument`, opt-in elsewhere; same XSS escaping
  (`escapeJsonForScript`) and the same `preScript`-before-`$SIGX_REPLACE`
  ordering for streamed components.
- Values must survive a JSON round trip; dev warnings mirror the existing
  signal-capture warnings.

### Layering

`useAsync` belongs to the component model, not to SSR — a pure SPA gets
working client semantics with zero SSR packages installed:

- **runtime-core** exports `useAsync` (resolving the instance via
  `getCurrentInstance()` synchronously at call time) and provides the
  default client implementation (fetch on setup, reactive states, abort on
  unmount) — this is `useAsync` done right.
- **server-renderer** swaps the implementation per environment, exactly as
  it already does for `ctx.ssr`: the server walk installs the
  await/stream/serialize variant in `createComponentState`; the hydration
  context extension installs the restore-or-refetch variant.

Internally the server variant *uses* `ssr.load` — `query` adds the value
contract, keys, dedupe, and error/loading states on top. No new core
rendering machinery.

### What happens to the other primitives

- **`ssr.load`** — stays, documented as the low-level escape hatch
  ("imperative multi-signal loads; you own naming and error handling").
  No breaking change.
- **`useAsync`** — upgraded in place. Existing unkeyed call sites keep
  compiling and working, with the server-side loader leak fixed (today it
  fires the loader, never awaits it, and bakes the loading skeleton into
  the HTML; fixed semantics: unkeyed never runs on the server). Adding a
  key opts a call into the full SSR story. No deprecation needed.
- **`Suspense` / `ssr.stream`** — unchanged. A `{ suspense: true }` query
  option (register with the boundary instead of rendering a loading branch)
  is future work, intentionally out of v1.

### Migration

```tsx
// Before                                          // After
const stats = (ctx.signal as any)(null, 'stats');  const stats = useAsync('stats',
ctx.ssr.load(async () => {                             () => fetchStats());
    stats.value = await fetchStats();
});
{stats.value ? render(stats.value)                 {stats.loading ? <Loading/> :
             : 'Loading…'}                          stats.error ? <Err/> : render(stats.value)}
```

No signal naming, no cast, no manual error handling, typed `value`.
`examples/spa-ssr` migrates as part of the implementation (StatsCard becomes
the `query` showcase).

## The async-context problem (why callbacks were the wrong shape)

`getCurrentInstance()` is **not reliable inside async code**, and `ssr.load`'s
callback style invites exactly that misuse:

- **Client:** the current instance is a module-level variable. The render
  walk sets it synchronously around `setup()` and restores it immediately
  after. Any composable called after an `await` — inside an `ssr.load`
  callback, or after the first `await` of an async setup — sees the wrong
  instance or `null`. `useHead()`, DI lookups (`useRouter()`), anything
  instance-dependent silently misbehaves.
- **Server:** AsyncLocalStorage (`async-context.ts`) isolates **between
  requests**, but within a request it is still one *mutable slot*. The slot
  is restored when setup returns; an `ssr.load` continuation that runs later
  reads whatever component the walk happens to be on. With streaming,
  deferred renders interleave with the main walk at await points, so even
  "it worked when I tried it" is timing luck.

This cannot be fully fixed for arbitrary user code in browsers (no ALS).
The realistic strategy is to make the well-lit path not need the instance
at all — which is the `query` design:

- Everything instance-dependent happens **synchronously in setup**
  (`useAsync(...)` itself, `useHead`, DI).
- The fetcher is a **pure data function**: it receives what it needs
  (`{ signal }`; props values are captured by the closure at setup time)
  and returns data. There is nothing to look up mid-flight.
- Dev-mode guard: `getCurrentInstance()` consulted from inside a query
  fetcher (detectable on the server via a flag around fetcher invocation)
  warns with a pointer to this section.

Optional server hardening (open question § below): wrap each component's
async continuations in their own `AsyncLocalStorage.run({ instance })` scope
so `getCurrentInstance()` becomes correct inside server-side fetchers and
`ssr.load` callbacks. Structured and correct, but per-component `als.run()`
has measurable overhead — it would be applied only on async paths (the sync
fast path never enters ALS), gated on a bench check. The client stays
discipline-by-design either way, so code relying on it would be
server-only — which argues for warning rather than supporting.

## `@sigx/store` SSR adapter (spec — implemented in the store repo)

Current store facts (`@sigx/store` v0.4.4): `defineStore` builds on
`defineFactory` with **Scoped lifetime** — per-request isolation via app DI
already works. `defineState` wraps one object signal per store, so a store
snapshot is exactly that object. There is **no SSR support today**: store
signals are created outside components, invisible to component-level state
capture.

The adapter (validates the SSRPlugin architecture — core needs nothing new):

1. **In `@sigx/store`:**
   - A per-scope registry of activated store instances:
     `getActiveStores(scope): Map<storeId, instance>` (instances exist with
     GUID-suffixed names; the registry keys by the **stable store id**).
   - A hydration seed: `seedStoreState(blob: Record<string, object>)` —
     `defineState` consults the seed for its store id before applying
     defaults, then deletes the entry (first instantiation wins).
   - **Invariant (dev-enforced):** one instance per store id per request
     scope. A second activation of the same id in one scope warns — the
     serialized blob would be ambiguous.
2. **`@sigx/store/ssr` plugin** (public `SSRPlugin` surface only):
   - `getInjectedHTML`: snapshot each active store's state object → emit
     `window.__SIGX_STORES__ = { counter: {...}, cart: {...} }`
     (XSS-escaped via `escapeJsonForScript`).
   - `onAsyncComponentResolved` → `preScript` for stores mutated by streamed
     components, mirroring `__SIGX_STATE__` ordering.
   - Client `beforeHydrate`: `seedStoreState(window.__SIGX_STORES__)`.
3. **Composition with `query`:** store actions may call fetches during SSR;
   results land in store state and ship in `__SIGX_STORES__`. Components may
   `query` and write into stores — both paths end up serialized. No special
   coupling required.

Sequencing: spec'd here; built as its own program in the store repo **after**
`ssr-next` is validated and merged (the adapter compiles against the
published plugin surface).

## Implementation plan (DONE — kept for reference)

1. `runtime-core`: `AsyncState<T>`/`AsyncOptions` types, `useAsync` export
   with the default client implementation + tests. Fix the `useAsync`
   server leak (separate commit; independent bug fix).
2. `server-renderer`: server implementation in `createComponentState`
   (dedupe via `_queryCache`, registers through `ssr.load` machinery);
   `__SIGX_ASYNC__` capture in `stateSerializationPlugin`; hydration
   restore-or-refetch in the context extension + `hydrateComponent`.
3. Tests: blocking/streaming/bot serialization, dedupe (one fetch per key),
   abort on unmount, fail-safe refetch when blob missing, `throwOnError`
   routing, round-trip hydration.
4. `examples/spa-ssr`: StatsCard → `useAsync`; README section.
5. Docs: "which async primitive do I use"
   table in the SSR docs.

## Open questions

1. **Key collisions in dev** — warn when one request registers the same key
   from two different fetcher functions (`fn.toString()` heuristic), or
   trust the SWR convention silently?
2. **`refresh()` on the server** — no-op (recommended) or throw in dev?
3. **Client-side cross-navigation cache** — v1 has none (each mount fetches
   unless restored). Accept, or reserve `staleTime` in `AsyncOptions` now to
   avoid a breaking change later?
4. **Blob naming** — `__SIGX_ASYNC__` separate from `__SIGX_STATE__`
   (proposed, keeps contracts independent) vs. one merged blob.
5. **Unkeyed + `options`** — should the unkeyed overload accept
   `AsyncOptions` too (`throwOnError` is meaningful without a key), or keep
   its signature minimal?
6. **Server-side per-component ALS scoping** — make `getCurrentInstance()`
   correct inside async continuations on the server (see "The async-context
   problem"), or keep one shared slot and warn in dev when the instance is
   read from a fetcher? Warning-only keeps server/client semantics
   identical; ALS-scoping makes server-only code subtly more capable than
   client code.
