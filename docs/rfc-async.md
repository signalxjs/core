# RFC: value-first async — loading, lazy, errors, transitions

Status: **proposed / under review**. Tracking: signalxjs/core#135. Pre-1.0,
no-compat (same stance as `docs/rfc-use-async.md`): one way to do it.

## Summary

Redesign sigx's async loading / lazy / error UX around a **value-first** model
that fits the fine-grained signal system: `useAsync` returns a reactive value
that carries its own `pending` / `error` / `ready` states, rendered with a
co-located `match` / `when` combinator. Multiple async values coordinate by
composition (`all([...])`), not by nesting wrapper components. The only
tree-positional primitive is a thin `<Stream>` for code-splitting and SSR flush
order.

## Motivation

The SSR/data layer is strong and stays: keyed `useAsync` transfer (dedupe,
serialize, restore), streaming SSR, `useStream`, islands selective hydration.
The client-composition layer has concrete gaps:

1. **`Suspense`/`lazy` rely on a throw-a-promise protocol + a module-global
   mutable boundary** (`lazy.tsx`). It is order-dependent (register-during-render,
   check-size-after) and fragile across nesting/concurrency.
2. **`ErrorBoundary` only catches the synchronous render pass**
   (`error-boundary.ts`, `try { slots.default() } catch`). An error thrown from a
   child's *reactive re-render* (its own effect) escapes it, and `retry()` only
   flips a flag — it doesn't re-run the failed work.
3. **No reactive key** — `useAsync`'s key is a static string fixed at setup, so a
   fetch can't re-run when a signal (route param, id) changes.
4. **No transitions** — every boundary flashes its fallback; no way to keep stale
   content visible while the next view loads.
5. **`__SIGX_ASYNC__` is a hydration blob, not a cache** — no staleTime, gc,
   revalidation, or mutations.

**Core idea:** in a fine-grained signal system, async state *is* reactive state.
So loading/error/transition handling can be plain reactive derivations over the
value — nothing needs to throw or unwind the tree, setup runs once, effects are
never discarded. The substrate already exists: `signal`, `effect` + `onCleanup`,
`effectScope`, and the DI/context system (`di/injectable.ts`).

## The design

### 1. `useAsync` — the one public primitive

No new public primitive (no `resource()` / `query()` / `@sigx/query`). An
internal reactive async engine powers `useAsync`; everything hangs off the object
it returns.

```ts
useAsync<T>(fetcher, options?): AsyncState<T>                 // unkeyed, client-only
useAsync<T>(key, fetcher, options?): AsyncState<T>            // keyed, SSR-transferable
useAsync<T>(() => `user:${id.value}`, fetcher, options?)     // GETTER key => reactive refetch

interface AsyncState<T> {
  readonly value: T | undefined;     // current; reading subscribes
  readonly latest: T | undefined;    // last resolved, kept across refresh (SWR)
  readonly loading: boolean;
  readonly error: unknown;
  readonly state: 'unresolved' | 'pending' | 'ready' | 'refreshing' | 'errored';

  // the boundary IS the value — loading/error/success co-locate here
  match<R>(arms: {
    pending?: () => R;
    error?:   (e: unknown, retry: () => void) => R;
    ready:    (v: T) => R;
  }): R;
  when<R>(ready: (v: T) => R): R | undefined;

  refresh(): Promise<void>;                               // re-run fetcher (= retry)
  mutate(next: T | ((prev: T | undefined) => T)): void;   // optimistic/local set
  invalidate(): void;                                     // drop cache entry, refetch live
}
```

```tsx
const user = useAsync('user', fetchUser);
return () => user.match({
  pending: ()         => <Skeleton/>,
  error:   (e, retry) => <Err e={e} onRetry={retry}/>,
  ready:   (u)        => <Profile user={u}/>,
});
```

Reactive key: when the key/source is a getter, an internal `effect`/`watch`
refetches on change and aborts the previous run via `AbortController` wired
through `onCleanup`. No throwing, no tree-positional boundary, no module global.

### 2. Coordinating several — value combinators (not nesting)

```tsx
const page = all([user, posts, prefs]);   // AsyncState<[U, P[], Prefs]>
return () => page.match({
  pending: () => <Skeleton/>,
  error:   (e, retry) => <Err e={e} onRetry={retry}/>,   // first error wins
  ready:   ([u, p, pr]) => <Page user={u} posts={p} prefs={pr}/>,
});
```

`all()` returns a derived `AsyncState` (pending until all settle, errored on the
first failure, ready with the tuple). Room for `race`/`any` later.

### 3. Errors — at the value; thin app-level catch-all for the rest

- **Data/async errors** → `match`'s `error` arm, co-located with the fetch;
  `retry` is `refresh()`.
- **Unexpected render throws** (bugs) → a single app-level handler. The renderer
  already carries `_onComponentError`; expose it as an app `onError` option, plus
  an optional thin `errorScope({ fallback, onError })` for sub-tree isolation when
  genuinely needed. No nested `<ErrorBoundary>` as the everyday API.

### 4. `lazy()` + SSR streaming — the one positional primitive

The single case where tree position truly matters: code-split chunk loading and
which HTML the server flushes first.

```tsx
const Chart = lazy(() => import('./Chart'));   // async value under the hood

<Stream fallback={<Skeleton/>}>     // marks an SSR flush point + shows fallback
  <Chart/>                          // while the chunk loads
</Stream>
```

`<Stream>` reads the lazy value's pending state reactively — no throw, no module
global — and is the boundary the existing streaming machinery keys off
(`__suspense` marker → flush fallback now, stream real markup later). It is the
only wrapper component in the design.

### 5. Transitions / concurrent (later phase)

```ts
const [isPending, startTransition] = useTransition();
startTransition(() => { route.value = next });   // hold stale content, no flash
const slow = deferred(() => expensiveDerived());
```

Writes inside `startTransition` are tagged; an async value whose reactive key
changes under that tag marks the run *transitional*. `match` becomes
transition-aware: while a transitional refetch is in flight and `latest` exists,
it keeps rendering the `ready` arm with `latest` (no `pending` flash) and
`isPending` is true, swapping when the run settles. Works because the value
retains `latest` — no scheduler/lane rewrite.

### 6. Caching, revalidation, mutations — all on `useAsync` (later phase)

No new package, no new name. `__SIGX_ASYNC__` evolves into the cache; control
surfaces through `useAsync` options + the returned methods:

```ts
const as = useAsync('user', fetchUser, {
  staleTime, gcTime, revalidateOnFocus, revalidateInterval, keepPreviousData,
});
as.mutate(u => ({ ...u, name }));  // optimistic local write (write-through, cross-mount)
as.invalidate();                   // drop entry + refetch live
```

### 7. SSR integration (preserve)

- Keyed `useAsync` already serializes/streams via the `_useAsync`/`_useStream`
  provider seams; `match` renders the `ready` arm server-side once the keyed value
  resolves — no boundary needed for data.
- `<Stream>` is the only thing the streaming path keys off (`render-core.ts`
  `__suspense` → `handleAsyncSetup` / `onAsyncComponentResolved` / `_pendingAsync`).
- Streaming, islands, keyed transfer, `blocking`/`stream` document modes unchanged.

## What's removed

- The throw-a-promise protocol and the module-global `currentSuspenseBoundary`.
- `Suspense` and `ErrorBoundary` as the primary wrapper-component model
  (superseded by `match`/`all`, `<Stream>`, and app-level `onError`/`errorScope`).

## Phasing

- **Phase 0:** this document.
- **Phase 1 — Foundation:** internal async-cell engine; `useAsync` reactive key +
  `match`/`when`/`mutate`/`invalidate`; `all()`; rebuild `lazy()` + thin
  `<Stream>`; app-level `onError` + optional `errorScope`. Delete throw protocol,
  global boundary, old `Suspense`/`ErrorBoundary`.
- **Phase 2 — Transitions:** `useTransition`/`startTransition`/`deferred`;
  `match` stale-hold.
- **Phase 3 — Cache/mutations on `useAsync`:** `staleTime`/`gcTime`, revalidation
  (focus/interval), `keepPreviousData`, write-through optimistic mutations.

Each phase = its own issue → worktree → PR → Copilot review → merge.

## Open questions

1. `match` arm naming — `pending`/`error`/`ready` vs `loading`/`error`/`data`?
2. Is `when(ready)` (render-only-when-ready) worth shipping, or does `match` with
   an optional `pending` cover it?
3. `all()` error semantics — first-error-wins (proposed) vs collect-all?
4. `errorScope` — ship in Phase 1, or defer until a real need appears (app-level
   `onError` only at first)?
5. Should `<Stream>` keep the name `Suspense` for familiarity, or is `Stream`
   clearer about what it does (SSR flush point)?
