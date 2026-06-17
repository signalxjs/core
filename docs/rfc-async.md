# RFC: value-first async — loading, lazy, errors, transitions

Status: **proposed / under review — rev 3** (revised after the rev-2 DX follow-up
on signalxjs/core#136). Tracking: signalxjs/core#135. Pre-1.0, no-compat (same
stance as `docs/rfc-use-async.md`): one way to do it.

> **rev-3 changes:** reads and writes are both `useAsync`, distinguished by
> *trigger mode* — a read is auto-triggered, a write is manual (`{ manual: true }`
> + `.run(input)`) with its own lifecycle; this replaces `mutate`/`invalidate` as
> read-state methods (those move to Phase 3 cache ops). `errorScope` is pinned to
> a setup-time, wrapper-free contract and ships in Phase 1. `match` is framed as
> sugar over plain `state` checks. Added the honesty note on the hybrid
> render model (P1 conceded). All five rev-2 open questions resolved.

## Summary

Redesign sigx's async UX around a **value-first** model that fits the
fine-grained signal system. One primitive, two trigger modes:

- **A read is an auto-triggered async value** — `useAsync(key, fetcher)`.
- **A write is a manually-triggered async value** — `useAsync(fn, { manual: true })`,
  fired with `.run(input)`, with its *own* pending/error lifecycle.

Both return the same `AsyncState` shape, rendered with a co-located `match`
combinator (sugar over plain `state` checks). Multiple values coordinate by
composition (`all({ ... })`), not by nesting wrapper components. The only
tree-positional primitive is a thin `<Defer>` for code-splitting and SSR flush
order.

## Motivation

The SSR/data layer is strong and stays: keyed `useAsync` transfer (dedupe,
serialize, restore), streaming SSR, `useStream`, islands selective hydration.
The client-composition layer has concrete gaps — stated against the current code:

1. **`Suspense`/`lazy` lean on a throw-a-promise protocol + register-during-render
   ordering.** `lazy()` already does reactive boundary registration
   (`registerPendingPromise`) with per-request `AsyncLocalStorage` — the
   module-global boundary is only the browser fallback. The fragility is the
   ordering (register *during* the children render, check `pending.size` *after*)
   and the `try/catch` on a thrown promise — not "a global".
2. **`ErrorBoundary` is a flag-flip, not recovery.** It catches only the
   synchronous render pass (`error-boundary.ts`), and `retry()` flips `hasError`
   without re-running the failed work. The **app-level** `app.config.errorHandler`
   *does* already catch setup + render-effect errors (`app.ts`
   `handleComponentError`) — so the missing piece is a *scoped, recoverable*
   boundary, not app-level catching.
3. **No reactive key, no conditional fetch** — the key is a static string fixed at
   setup, so a fetch can't re-run when a signal changes, and there's no "not yet".
4. **No write story** — the shipped `useAsync` is read-only. Writes
   (form submits, mutations) have a different lifecycle (own pending/error,
   trigger on demand, invalidate other reads) and today fall back to hand-rolled
   `signal(false)` button state.
5. **No transition stale-hold across a key change.**
6. **`__SIGX_ASYNC__` is a cache without policy** — already a page-lifetime data
   cache (restores keyed `useAsync` across mounts), but no `staleTime`, `gcTime`,
   revalidation, or mutation controls.

**Core idea:** in a fine-grained signal system, async state *is* reactive state —
read or write. The substrate exists: `signal`, `watch` (with `onCleanup`),
`effectScope`, the DI/context system, and a renderer that diff-patches in place.

## The design

### 1. Reads — auto-triggered `useAsync`

An internal reactive async engine powers `useAsync` (no public `resource()` /
`query()`). **One signature fuses the reactive key, the fetcher's key, and
conditional fetching:**

```ts
useAsync<T>(key, fetcher, options?): AsyncState<T>   // keyed, SSR-transferable
useAsync<T>(fetcher, options?): AsyncState<T>         // unkeyed, client-only

// `key` is `string` OR a getter. A getter is tracked: a signal read inside it
// re-runs the fetch on change. Returning null/undefined/false ⇒ state 'idle',
// the fetcher does NOT run (conditional fetch). The resolved key is passed to
// the fetcher, so you never read the signal twice:
const post = useAsync(
  () => user.value ? `post:${postId.value}` : null,   // null ⇒ idle/skip
  (key, { signal }) => fetchPost(key, signal),
);
```

`AsyncState` — `state` is the canonical truth; `match` and `loading` are sugar:

```ts
interface AsyncState<T> {
  readonly state: 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';
  readonly value: T | null;          // SWR last-good; null until first success, kept across refresh
  readonly error: Error | null;      // normalized; mutually exclusive with a fresh value
  readonly loading: boolean;         // derived sugar: state === 'pending' || 'refreshing'

  // sugar over the state checks above — not load-bearing
  match<R>(arms: {
    pending?: () => R;                              // omitted ⇒ renders nothing while pending
    error?:   (e: Error, retry: () => void) => R;   // omitted ⇒ renders null + bubbles to onError
    ready:    (v: T) => R;                          // required: the happy path
  }): R;

  refresh(): Promise<void>;          // re-run the fetcher in place (this is `retry`)
}
```

**State → arm mapping** (`match` is exactly this table):

| `state` | `value` | `match` renders |
|---|---|---|
| `idle` / `pending` | null | `pending` |
| `ready` / `refreshing` | present | `ready(value)` — live, stale-while-revalidating |
| `errored` | null | `error(e, retry)`, or `null` + bubble to `onError` if no `error` arm |

**No `latest`, no flash, but honest about the model.** `value` already is the
SWR last-good value, so a separate `latest` is redundant (dropped). The `ready`
arm is a snapshot callback `(v) => JSX`; when `value` changes the arm
**re-executes and the renderer diff-patches its returned subtree against the
previous one** (`renderer.ts` `componentEffect` → `patch`) — no remount, no flash.
This is sigx's hybrid model: fine-grained *signals* drive coarse-grained
render-fn re-execution + a real vdom diff. It's cheap, but it is *not* Solid-style
targeted node update — the whole returned subtree is re-evaluated and re-diffed on
each change. (Conceded from rev-2's P1: props are snapshots, not live accessors;
diff-in-place, not an accessor, is what removes the flash.)

The engine rides `watch` (which has `onCleanup`) + an `AbortController` to cancel
the previous run on key change or unmount.

### 2. Writes — manual-triggered `useAsync`

A write is the same primitive with `{ manual: true }`: it does **not** auto-run,
and exposes `.run(input)`. It is a first-class async value with its *own*
lifecycle — its own `loading` (the submit spinner), its own `error` (a 409/
validation distinct from any read's fetch error):

```tsx
const save = useAsync(saveUser, { manual: true });
//    save.loading / save.error / save.state / save.match  ← the write's own lifecycle

<button disabled={save.loading}
        onClick={() => save.run(draft).then(() => user.refresh())}>
  Save
</button>
```

- `.run(input): Promise<T>` triggers the fetcher with the input, updates the
  write's own state, and resolves/rejects so the caller can chain.
- **Cross-read invalidation is explicit and obvious:** the write's success path
  calls the dependent read's `user.refresh()` (Phase 1) — and, once cache policy
  exists, `user.invalidate()` (Phase 3, cache-aware). No implicit graph.
- This keeps **one primitive**, value-first, no datastore vocabulary, and gives
  writes a real lifecycle — instead of hanging `mutate`/`invalidate` off a read's
  state (which would give a write none of its own pending/error/rollback).

### 3. Coordinating several — `all({ ... })`

```tsx
const page = all({ user, posts, prefs });   // AsyncState<{ user: U; posts: P[]; prefs: Prefs }>
return () => page.match({
  pending: () => <Skeleton/>,
  error:   (e, retry) => <Err e={e} onRetry={retry}/>,   // first error wins
  ready:   ({ user, posts, prefs }) => <Page user={user} posts={posts} prefs={prefs}/>,
});
```

- Object form is primary (named destructure scales); a rest-arg tuple `all(a, b, c)`
  stays for quick cases (rest args ⇒ TS infers a tuple).
- Returns a derived `AsyncState`: pending until all settle, `ready` with the
  combined value, `error` on first failure; exposes **`.errors`** (all failures)
  so collect-all needs no second API.
- **`all()` is only for all-or-nothing gating.** Partial loading ("show the user
  now, spinner while posts load") needs no `all` and no new API — the caller still
  holds each value, so compose `user.match(...)` and `posts.match(...)`
  independently.

### 4. Errors — at the value; one app handler; one scoped boundary

- **Data/async errors** → `match`'s `error` arm; `retry` is `refresh()`. Omitting
  the arm renders `null` and **bubbles the error** to the nearest `errorScope` /
  app `onError` (never silently swallowed); a dev-mode warning fires the first
  time so the bubble is discoverable rather than a blank slot.
- **App-level handler** → surface the existing `app.config.errorHandler` (already
  routes setup + render-effect errors) as app `onError`. A rename/surfacing, not
  a new capability. Catches event-handler throws and anything unhandled below.
- **`errorScope` — scoped, recoverable, wrapper-free (ships Phase 1).** A
  **setup-time call inside a component that scopes that component's own subtree**
  (it provides a handler via DI — `handleComponentError` walks the instance parent
  chain via the existing `lookupProvided` traversal). On a throw from the
  component's render or a descendant's render/effect, the component renders
  `fallback(e, retry)` **instead of** its normal output; `retry` tears down and
  rebuilds the subtree (`effectScope.stop()` + remount), not a flag flip.

```tsx
const App = component(() => {
  errorScope({ fallback: (e, retry) => <Err e={e} onRetry={retry}/>, onError: report });
  return () => <Dashboard/>;   // a throw anywhere under here renders the fallback; retry remounts
});
```

  It explicitly does **not** catch async-fetcher rejections (those are
  `match.error`) or event-handler throws (app `onError`). There is no
  `<ErrorBoundary>` wrapper.

### 5. `lazy()` + `<Defer>` — the one positional primitive

Code-split chunk loading and SSR flush order are the only case where a tree
position matters. Named `<Defer>` (not `Stream`, which collides with `useStream`;
not `Await`, which is taken by Remix/React-Router and implies awaiting a data
value):

```tsx
const Chart = lazy(() => import('./Chart'));

<Defer fallback={<Skeleton/>}>     // SSR flush point + fallback while the chunk loads
  <Chart/>
</Defer>
```

`<Defer>` reads the lazy value's pending state reactively — no throw, no
register-during-render ordering — and is the boundary the streaming machinery
keys off (`__suspense` marker → flush fallback now, stream real markup later). It
is the only wrapper component in the design.

### 6. Transitions / concurrent (Phase 2)

```ts
const [isPending, startTransition] = useTransition();
startTransition(() => { route.value = next });   // hold previous content, no flash
```

No accessor mechanism needed (see §1). A reactive-key change under a transition
keeps the previous `value` (`keepPreviousData`) so `match` keeps rendering `ready`
(state `refreshing`) with `isPending` true, swapping when the run settles; the
renderer diff-patches the swap in place. `deferred(() => expensive())` covers
low-priority derived values.

### 7. Cache, revalidation, optimistic mutations (Phase 3)

`__SIGX_ASYNC__` grows policy metadata; knobs are grouped so the beginner
signature stays `useAsync(key, fetcher)`:

```ts
const user = useAsync('user', fetchUser, {
  cache: { staleTime, gcTime, revalidateOnFocus, revalidateInterval, keepPreviousData },
});
user.invalidate();                 // drop the cache entry + refetch live (cache-aware)
user.mutate(u => ({ ...u, name })); // optimistic local cache write (write-through)
```

`invalidate` and `mutate` are **cache operations** and arrive with the cache —
not in Phase 1, where (with no policy) `invalidate` would be indistinguishable
from `refresh`.

### 8. SSR integration (preserve)

- Keyed `useAsync` already serializes/streams via the `_useAsync`/`_useStream`
  seams; `match` renders the `ready` arm server-side once the keyed value
  resolves. **Unkeyed** `useAsync` renders the `pending` arm server-side — flag
  the potential hydration flash. Manual writes don't run during SSR.
- `<Defer>` is the only thing the streaming path keys off (`render-core.ts`
  `__suspense` → `handleAsyncSetup` / `onAsyncComponentResolved` / `_pendingAsync`).
- Streaming, islands, keyed transfer, `blocking`/`stream` modes unchanged.

## Removed vs renamed

- **Removed:** the throw-a-promise protocol, register-during-render ordering, the
  `<Suspense>` wrapper, `<ErrorBoundary>` as a flag-flip, the redundant `latest`,
  the standalone `when()` (covered by `match`), and `mutate`/`invalidate` as
  read-state methods in Phase 1 (return as Phase-3 cache ops).
- **Renamed / surfaced:** `app.config.errorHandler` → app `onError`; `<Stream>` →
  `<Defer>`.

## Phasing

- **Phase 0:** this document.
- **Phase 1 — Foundation:** internal async-cell engine (rides `watch`);
  `useAsync` reads (fused conditional key) + `match` + `refresh`; `useAsync`
  writes (`{ manual: true }` + `.run`); `all({...})` + `.errors`; rebuild `lazy()`
  + thin `<Defer>`; surface app `onError`; `errorScope` (pinned contract). Delete
  throw protocol, register-during-render boundary, old `Suspense`/`ErrorBoundary`,
  `latest`.
- **Phase 2 — Transitions:** `useTransition`/`startTransition`/`deferred`;
  `keepPreviousData` stale-hold.
- **Phase 3 — Cache:** `cache: { staleTime, gcTime, … }`, revalidation,
  `invalidate`, optimistic `mutate`.

Each phase = its own issue → worktree → PR → Copilot review → merge.

## Resolved decisions

- **P1** conceded — snapshot arm + diff-in-place, no live accessor (honesty note
  in §1).
- Arm names `pending`/`error`/`ready`; `match` is sugar over `state`.
- Missing `error` arm ⇒ `null` + bubble to `onError` + first-time dev warning.
- `errorScope` ships Phase 1 with the §4 contract (effect-throw capture + real
  `retry`); scopes the calling component's own subtree, wrapper-free.
- Keep both `state` and `loading` (`loading` is derived sugar). No `isReady`/`isError`.
- `idle` via a null/false **getter** key only — no `enabled`/`skip` option.
- `all()` errors: first-error-wins + `.errors`; partial loading uses independent
  `match`, not `all`.
- `<Defer>` (over `Stream`/`Await`).
- Writes = manual-trigger `useAsync` (`{ manual: true }` + `.run`), not
  `mutate`/`invalidate` on a read; those become Phase-3 cache ops.

## Open questions

1. **Manual-write API surface** — `{ manual: true }` + `.run(input)` (proposed) vs
   a distinct factory; and whether `.run` should support optimistic apply +
   rollback in Phase 1 or wait for the cache (Phase 3).
2. **`createAsyncCell` escape hatch** — keep the async engine internal for now, and
   expose it (with `useAsync` as thin sugar) only if a power-user/library need
   appears? Split by *layer*, not feature.
