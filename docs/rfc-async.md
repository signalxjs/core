# RFC: value-first async — loading, lazy, errors, transitions

Status: **proposed / under review — rev 2** (revised after DX review on
signalxjs/core#136). Tracking: signalxjs/core#135. Pre-1.0, no-compat (same
stance as `docs/rfc-use-async.md`): one way to do it.

> **rev-2 changes:** corrected the motivation against the shipped code; fused the
> reactive key, the fetcher key, and conditional fetching into one signature (P2);
> dropped `latest` and made `state` canonical with a published state→arm table
> (P3); `all({...})` object form + `.errors` (P4); errors reuse the existing
> app-level handler, with a scoped recoverable `errorScope` as the one genuinely
> new capability (P5); renamed `<Stream>` → `<Defer>` to avoid colliding with
> `useStream` (P6); reframed transitions to need no accessor mechanism.

## Summary

Redesign sigx's async loading / lazy / error UX around a **value-first** model
that fits the fine-grained signal system: `useAsync` returns a reactive value
that carries its own states, rendered with a co-located `match` combinator.
Multiple async values coordinate by composition (`all({ ... })`), not by nesting
wrapper components. The only tree-positional primitive is a thin `<Defer>` for
code-splitting and SSR flush order.

## Motivation

The SSR/data layer is strong and stays: keyed `useAsync` transfer (dedupe,
serialize, restore), streaming SSR, `useStream`, islands selective hydration.
The client-composition layer has concrete gaps — stated accurately against the
current code:

1. **`Suspense`/`lazy` lean on a throw-a-promise protocol + register-during-render
   ordering.** `lazy()` already does reactive boundary registration
   (`registerPendingPromise`) with per-request `AsyncLocalStorage`
   (`async-context.ts`) — the module-global boundary is only the browser
   fallback. The real fragility is the ordering (register a promise *during* the
   children render, then check `pending.size` *after*) and the `try/catch` on a
   thrown promise in `Suspense` — not "a global".
2. **`ErrorBoundary` is a flag-flip, not recovery.** The component catches only
   the synchronous render pass (`error-boundary.ts`, `try { slots.default() }
   catch`), and `retry()` flips `hasError` without re-running the failed work.
   Note: the **app-level** `app.config.errorHandler` *does* already catch setup
   and render-effect errors (`app.ts` `handleComponentError`) — so the missing
   piece is a *scoped, recoverable* boundary, not app-level catching.
3. **No reactive key** — `useAsync`'s key is a static string fixed at setup, so a
   fetch can't re-run when a signal (route param, id) changes, and there's no
   first-class "don't fetch yet" (conditional) state.
4. **No transition stale-hold across a key change** — when the inputs change there
   is no built-in way to keep the previous content visible while the next loads.
5. **`__SIGX_ASYNC__` is a cache without policy** — it already acts as a
   page-lifetime data cache (restores keyed `useAsync` across mounts/remounts),
   but has no `staleTime`, `gcTime`, revalidation, or mutation controls.

**Core idea:** in a fine-grained signal system, async state *is* reactive state.
Loading/error/transition handling become plain reactive derivations over the
value — nothing throws or unwinds the tree, setup runs once. The substrate
exists: `signal`, `watch` (with `onCleanup`), `effectScope`, the DI/context
system, and a renderer that **diff-patches in place** (so re-running a render arm
updates the DOM without a remount or flash).

## The design

### 1. `useAsync` — the one public primitive

No new public primitive (no `resource()` / `query()` / `@sigx/query`). An
internal reactive async engine powers `useAsync`; everything hangs off the object
it returns.

**One signature fuses the reactive key, the fetcher's key, and conditional
fetching (P2):**

```ts
useAsync<T>(fetcher, options?): AsyncState<T>                 // unkeyed, client-only
useAsync<T>(key, fetcher, options?): AsyncState<T>            // keyed, SSR-transferable

// `key` is `string` OR a getter. A getter is tracked: any signal read inside it
// re-runs the fetch when it changes. A getter returning null/undefined/false
// means "not ready" → state is 'idle', the fetcher does NOT run.
// The resolved key is passed to the fetcher, so you never read the signal twice:
const post = useAsync(
  () => user.value ? `post:${postId.value}` : null,   // reactive key; null ⇒ idle/skip
  (key, { signal }) => fetchPost(key, signal),
);
```

```ts
interface AsyncState<T> {
  readonly value: T | null;          // SWR last-good value; null until first success, kept across refresh
  readonly error: Error | null;      // normalized to Error; mutually exclusive with a fresh value
  readonly state: 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';
  readonly loading: boolean;         // derived sugar: state is 'pending' or 'refreshing'

  // the boundary IS the value — loading/error/success co-locate here
  match<R>(arms: {
    pending?: () => R;                         // omitted ⇒ renders nothing while pending
    error?:   (e: Error, retry: () => void) => R;   // omitted ⇒ error bubbles to app onError
    ready:    (v: T) => R;                     // required: the happy path
  }): R;

  refresh(): Promise<void>;                               // re-run fetcher in place (this is `retry`)
  mutate(next: T | ((prev: T | null) => T)): void;        // optimistic/local set (write-through)
  invalidate(): void;                                     // drop the cache entry, then refetch live
}
```

**State → arm mapping** (canonical; `match` is just this table):

| `state` | `value` | `match` renders |
|---|---|---|
| `idle` | null | `pending` (nothing to do yet) |
| `pending` | null | `pending` |
| `ready` | present | `ready(value)` |
| `refreshing` | present | `ready(value)` — live, stale-while-revalidating |
| `errored` | null | `error(e, retry)`, or bubbles to app `onError` if no `error` arm |

**Why no `latest`, and why no flash without an accessor.** `value` already *is*
the SWR last-good value (kept across `refresh()`), so a separate `latest` is
redundant — dropped. The `ready` arm is an ordinary snapshot callback
`(v) => JSX`; when the value changes the arm re-runs, and the renderer
**diff-patches the existing DOM in place** — no remount, no flash. (Props in sigx
are snapshots, not live accessors, so the arm does re-execute; diffing, not a
live ref, is what keeps it flicker-free.)

The reactive-key engine rides `watch` (which has `onCleanup`) + an
`AbortController` to cancel the previous run on key change or unmount.

### 2. Coordinating several — value combinators (not nesting)

```tsx
const page = all({ user, posts, prefs });   // AsyncState<{ user: U; posts: P[]; prefs: Prefs }>
return () => page.match({
  pending: () => <Skeleton/>,
  error:   (e, retry) => <Err e={e} onRetry={retry}/>,   // first error wins
  ready:   ({ user, posts, prefs }) => <Page user={user} posts={posts} prefs={prefs}/>,
});
```

- **Object form is primary** (P4): named destructure scales past 2–3 sources and
  reads better than a positional tuple. A rest-arg tuple form `all(a, b, c)` stays
  for quick cases (rest args so TS infers a tuple, not a widened array).
- `all(...)` returns a derived `AsyncState`: pending until all settle, `ready`
  with the combined value, `error` on the first failure. It also exposes
  **`.errors`** (all failures), so "collect-all" needs no second API.

### 3. Errors — at the value; one app-level handler; one scoped boundary

- **Data/async errors** → `match`'s `error` arm, co-located with the fetch;
  `retry` is `refresh()`. **Omitting the `error` arm is not silent**: the error
  bubbles to the app-level handler, so no data error is ever swallowed.
- **App-level handler** → surface the **existing** `app.config.errorHandler`
  (which already routes setup + render-effect errors via `handleComponentError`)
  as `app onError`. This is a rename/surfacing, not a new capability.
- **Scoped recovery (`errorScope`)** → the one genuinely new thing the old
  `ErrorBoundary` couldn't do: catch errors for a subtree — **including throws
  from a child's reactive re-render/effect**, which the renderer already catches
  per-component — render a fallback, and have `retry` actually **re-run the failed
  work** (not flip a flag).

```tsx
errorScope({
  fallback: (e, retry) => <Err e={e} onRetry={retry}/>,
  onError: (e) => report(e),
});
```

Ship `errorScope` in Phase 1 only if the recoverable retry + effect-throw capture
work cleanly; otherwise app-level `onError` alone covers Phase 1 and `errorScope`
defers. There is no `<ErrorBoundary>` wrapper.

### 4. `lazy()` + `<Defer>` — the one positional primitive

The single case where tree position truly matters: code-split chunk loading and
which HTML the server flushes first. Named `<Defer>` (not `Stream`) to avoid
colliding with `useStream` (progressive text):

```tsx
const Chart = lazy(() => import('./Chart'));   // async value under the hood

<Defer fallback={<Skeleton/>}>     // marks an SSR flush point + shows fallback
  <Chart/>                         // while the chunk loads
</Defer>
```

`<Defer>` reads the lazy value's pending state reactively — no throw, no
register-during-render ordering — and is the boundary the existing streaming
machinery keys off (`__suspense` marker → flush fallback now, stream real markup
later). It is the only wrapper component in the design.

### 5. Transitions / concurrent (later phase)

```ts
const [isPending, startTransition] = useTransition();
startTransition(() => { route.value = next });   // hold previous content, no flash
```

No accessor mechanism is needed (see §1). Writes inside `startTransition` are
tagged; when a reactive-key change under that tag triggers a refetch, the engine
**keeps the previous `value`** (`keepPreviousData`) so `match` keeps rendering
`ready` with it (state `refreshing`) and `isPending` is true, swapping when the
run settles. Because the renderer diff-patches, the swap is in place. No
scheduler/lane rewrite. `deferred(() => expensiveDerived())` covers low-priority
derived values.

### 6. Caching, revalidation, mutations — all on `useAsync` (later phase)

No new package, no new name. `__SIGX_ASYNC__` grows policy metadata; control
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
  resolves. **Unkeyed** `useAsync` renders the `pending` arm server-side and
  fetches on the client — flag this potential hydration flash in the docs.
- `<Defer>` is the only thing the streaming path keys off (`render-core.ts`
  `__suspense` → `handleAsyncSetup` / `onAsyncComponentResolved` / `_pendingAsync`).
- Streaming, islands, keyed transfer, `blocking`/`stream` document modes unchanged.

## Removed vs renamed

- **Removed:** the throw-a-promise protocol, register-during-render ordering, the
  `<Suspense>` wrapper, and `<ErrorBoundary>` as a flag-flip; the redundant
  `latest`; the standalone `when()` (covered by `match` with optional arms).
- **Renamed / surfaced:** `app.config.errorHandler` → app `onError`; `<Stream>` →
  `<Defer>`.

## Phasing

- **Phase 0:** this document.
- **Phase 1 — Foundation:** internal async-cell engine (rides `watch`); `useAsync`
  fused signature (reactive/conditional key) + `match` + `mutate`/`invalidate`;
  `all({...})` + `.errors`; rebuild `lazy()` + thin `<Defer>`; surface app
  `onError`; `errorScope` if recoverable-retry works. Delete throw protocol,
  register-during-render boundary, old `Suspense`/`ErrorBoundary`, `latest`.
- **Phase 2 — Transitions:** `useTransition`/`startTransition`/`deferred`;
  `keepPreviousData` stale-hold.
- **Phase 3 — Cache/mutations on `useAsync`:** `staleTime`/`gcTime`, revalidation
  (focus/interval), write-through optimistic mutations.

Each phase = its own issue → worktree → PR → Copilot review → merge.

## Resolved decisions

- Arm names: `pending` / `error` / `ready` (state names, not value names).
- `all()` errors: first-error-wins for the `error` arm + `.errors` for collect-all.
- `<Defer>` over `<Stream>`/`<Suspense>`.
- Drop `when()` (fewer concepts; `match` covers it). *(Copilot preferred keeping
  it as sugar — noted, but going with fewer concepts.)*

## Open questions

1. **Unhandled `error` arm** — confirm the guarantee that a missing `error` arm
   bubbles to app `onError` (proposed: yes — no silent swallow).
2. **`errorScope` in Phase 1?** — only if it catches reactive re-render/effect
   throws *and* `retry` re-runs the work; otherwise defer (app `onError` ships in
   Phase 1 regardless).
3. **`state` vs `loading`** — keep both (`loading` as derived sugar) or expose only
   `state` to avoid two words for "in flight"?
4. **`idle` semantics** — is a `null` key the right "skip" signal, or do we want an
   explicit `enabled`/`skip` option too?
5. **`<Defer>` vs `<Await>`** — final name for the positional primitive.
