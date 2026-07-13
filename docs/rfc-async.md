# RFC: value-first async — loading, lazy, errors; mechanism in core, policy in packs

Status: **proposed / under review — rev 5**. Tracking: signalxjs/core#135.
Pre-1.0, no-compat (same stance as `docs/rfc-use-async.md`): one way to do it.

> **rev-5 changes:** the primitive becomes a named read/write pair —
> **`useData`** (reads, renamed from `useAsync`) and **`useAction`** (writes,
> replacing `useAsync(fn, { manual: true })`).
>
> *Why the write split (safety, not taste):* in a signals framework the
> natural write is a **zero-arg closure** over reactive state
> (`() => saveUser(draft.value)`), and a zero-arg function is assignable to
> every fetcher overload — so *forgetting the option compiles clean, resolves
> to the unkeyed-read overload, and auto-fires the mutation on mount*
> (`useAsync(logout)` logs the user out on render). No type or runtime check
> can catch intent; a named primitive makes the mistake unwritable.
>
> *Why the read rename:* once writes split out, "async" stops carving
> anything — an action is exactly as async as a read. The read is named for
> its purpose: components declare the **data** they need; *give your data a
> key and it transfers.* Naming history: `useQuery` re-rejected
> (TanStack/datastore vocabulary — it promises a data client core
> deliberately doesn't ship, §7); `useResource` re-rejected (borrowed Solid
> vocabulary, no purpose gain); `useAsyncData`/`useAsyncAction` rejected (the
> prefix adds no information — there is no sync `useData` to disambiguate
> from — and `useAsyncData` collides head-on with Nuxt's composable of the
> same name and signature). The shipped `useAsync` composable is renamed in
> place — pre-1.0, no-compat. One *concept*, one engine, a read/write pair —
> like `signal`/`computed`.
>
> **rev-4 changes (the scope cut):** core ships only what **only the framework
> can do** — the cache/revalidation/optimistic layer (rev-3 Phase 3) moves out
> of core entirely and becomes a **pack contract** over the existing provider
> seam (§7). Transitions (rev-3 Phase 2) are demoted from a committed phase to
> evidence-driven future work (§8). The TanStack alternative is addressed
> head-on (§9). DX decisions folded in: `.run` returns a settled result (never
> rejects); one fetcher shape everywhere (`(arg, ctx)`); writes get a distinct
> `AsyncAction` type; `match` reframed as "sugar at runtime, load-bearing for
> types"; write-retry and re-run concurrency pinned; `all().errors` specified;
> the scoped-isolation migration pattern shown. `createAsyncCell` stays
> internal (resolved).

## Summary

Redesign sigx's async UX around a **value-first** model that fits the
fine-grained signal system. One concept — a reactive async cell — as a
read/write pair:

- **A read is an auto-triggered async value** — `useData(key, fetcher)`
  (renamed from the shipped `useAsync`; see the rev-5 note).
- **A write is a manually-triggered async value** — `useAction(fn)`,
  fired with `.run(input)`, with its *own* pending/error lifecycle.

Both are rendered with a co-located `match` combinator; multiple values
coordinate by composition (`all({ ... })`), not by nesting wrapper components.
The only tree-positional primitive is a thin `<Defer>` for code-splitting and
SSR flush order.

**The scope principle (rev 4):** core ships *mechanism* — the things only the
framework can do (SSR transfer, the renderer-coupled `lazy`/`<Defer>`, error
propagation, the reactive async cell). Cache *policy* (`staleTime`,
revalidation, invalidation, optimistic mutations) is an application-layer
concern and ships as a **pack** over the same provider seam the server
renderer already uses. No framework core ships a query client — Vue, React,
Solid, and Svelte all draw this line (Solid's `createResource` stops exactly
where this RFC's core phase stops) — and sigx's own architecture (islands,
the store SSR adapter) already draws it too: mechanism in core, policy in
packs.

## Motivation

The SSR/data layer is strong and stays: keyed data transfer (dedupe,
serialize, restore), streaming SSR, `useStream`, islands selective hydration.
The client-composition layer has concrete gaps — stated against the current code:

1. **`Suspense`/`lazy` lean on a throw-a-promise protocol + register-during-render
   ordering.** `lazy()` already does reactive boundary registration
   (`registerPendingPromise`) with per-request `AsyncLocalStorage` — the
   module-global boundary is only the browser fallback. The fragility is the
   ordering (register *during* the children render, check `pending.size` *after*)
   and the `try/catch` on a thrown promise — not "a global".
2. **`ErrorBoundary` catches too little and recovers too shallowly.** Its
   `try/catch` wraps only the synchronous slot render (`error-boundary.ts`) —
   a throw from a child's reactive re-render or effect never reaches it. And
   while `retry()` does re-render the slot (resetting the reactive flag
   re-runs the render fn), it performs no scoped teardown/remount — partially
   initialized child state and effects survive into the retry. The
   **app-level** `app.config.errorHandler`
   *does* already catch setup + render-effect errors (`app.ts`
   `handleComponentError`) — so the missing piece is a *scoped, recoverable*
   boundary, not app-level catching.
3. **No reactive key, no conditional fetch** — the key is a static string fixed at
   setup, so a fetch can't re-run when a signal changes, and there's no "not yet".
4. **No write story** — the shipped `useAsync` is read-only. Writes
   (form submits, mutations) have a different lifecycle (own pending/error,
   trigger on demand, invalidate other reads) and today fall back to hand-rolled
   `signal(false)` button state.
5. **`__SIGX_ASYNC__` is a cache without policy** — already a page-lifetime data
   cache (restores keyed `useAsync` across mounts), but no `staleTime`, `gcTime`,
   revalidation, or mutation controls. *(rev 4: giving it policy is a pack's
   job — core's job is to make the pack possible, §7.)*

Every item on this list except the last requires renderer or SSR-seam
cooperation — that is the test for core membership, and the last item fails
it.

**Core idea:** in a fine-grained signal system, async state *is* reactive state —
read or write. The substrate exists: `signal`, `watch` (with `onCleanup`),
`effectScope`, the DI/context system, and a renderer that diff-patches in place.

## The design

### 1. Reads — `useData`

An internal reactive async engine powers `useData` (no public `resource()` /
`query()`; the engine stays internal — resolved, previously open). **One
signature fuses the reactive key, the fetcher's argument, and conditional
fetching:**

```ts
type Key = string | null | undefined | false;               // skip values: see below
type Fetcher<T, Arg> = (arg: Arg, ctx: { signal: AbortSignal }) => Promise<T>;

useData<T>(key: string,    fetcher: Fetcher<T, string>, opts?): AsyncState<T>;   // keyed, SSR
useData<T>(key: () => Key, fetcher: Fetcher<T, string>, opts?): AsyncState<T>;   // reactive key
useData<T>(fetcher: Fetcher<T, undefined>,              opts?): AsyncState<T>;   // unkeyed, client-only
useAction<T, In = void>(fn: Fetcher<T, In>): AsyncAction<T, In>;                 // write, §2
```

**One fetcher shape everywhere.** The fetcher's first argument is always *the
trigger's argument*: the resolved key for auto reads, the `.run(input)` value
for actions, `undefined` for unkeyed reads. One mental model — and it makes
overload disambiguation mechanical (two functions ⇒ the first is a key
getter; one function ⇒ it is the fetcher).

```tsx
const post = useData(
  () => user.value ? `post:${postId.value}` : null,   // getter key: tracked; null ⇒ idle/skip
  (key, { signal }) => fetchPost(key, { signal }),    // resolved key passed in — no double read
);
```

**Skip values, pinned:** the getter skips (state `'idle'`, fetcher not run) on
**any falsy result** — `null`, `undefined`, `false`, and `''`. Making the
contract exactly "falsy" keeps implementations (`if (!key)`) and user
intuition aligned; there is no legitimate empty-string key. Because an `''`
usually means an interpolation bug rather than intent, it additionally fires
a one-time dev-mode warning ("empty key skipped — did you mean to return
null?").

`AsyncState` — `state` is the canonical truth:

```ts
interface AsyncState<T> {
  readonly state: 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';
  readonly value: T | null;          // SWR last-good; null until first success, kept across refresh
  readonly error: Error | null;      // normalized; mutually exclusive with a fresh value
  readonly loading: boolean;         // derived sugar: state === 'pending' || state === 'refreshing'

  match<R>(arms: {
    pending?: () => R;                              // omitted ⇒ renders nothing while pending
    error?:   (e: Error, retry: () => void) => R;   // omitted ⇒ renders null + bubbles to onError
    ready:    (v: T) => R;                          // required: the happy path
  }): R | undefined;

  refresh(): Promise<void>;          // re-run the fetcher in place (this is `retry`)
}
```

**`match` is sugar at runtime, load-bearing for types.** Plain `state` checks
work (`if (x.loading) …`), but TypeScript cannot narrow `value: T | null`
across reactive getter reads — `ready: (v: T) => R` is the only *type-safe*
path to a non-null `T`. `match` also carries the error-bubbling guarantee
(an omitted `error` arm is never silently swallowed). Both are contract, not
convenience.

**State → arm mapping** (`match` is exactly this table):

| `state` | `value` | `match` renders |
|---|---|---|
| `idle` / `pending` | null | the `pending` arm, or nothing if it's omitted |
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
each change.

The engine rides `watch` (which has `onCleanup`) + an `AbortController`.
**Concurrency rule — one for the whole primitive:** a newer run supersedes and
aborts an in-flight one; on key change, on `refresh()`, and on a write's
repeated `.run()` (§2).

### 2. Writes — `useAction`

A write is the same reactive async cell with a manual trigger: it never
auto-runs, and exposes `.run(input)`. It is a **named primitive** (not a
`useAsync` option — see the rev-5 note in the header: a zero-arg write
closure would make a forgotten option compile clean and auto-fire the
mutation on mount) and returns a distinct type:

```ts
type RunResult<T> = { ok: true; value: T } | { ok: false; error: Error };

interface AsyncAction<T, In> {
  readonly state: 'idle' | 'pending' | 'ready' | 'errored';   // no 'refreshing'
  readonly value: T | null;          // last successful result
  readonly error: Error | null;
  readonly loading: boolean;         // state === 'pending'
  match<R>(arms: { /* same arms; retry = re-run last input */ }): R | undefined;
  run(input: In): Promise<RunResult<T>>;
}                                    // no refresh() on a write
```

**`.run` never rejects — errors are values here too.** A rejecting promise
would make the most common usage (fire-and-forget `onClick` with the UI
reading `save.error`) emit an unhandled-rejection warning on every failure;
TanStack's answer is two methods (`mutate`/`mutateAsync`), which is exactly
the fragmentation this design rejects. One method, both usages safe:

```tsx
const save = useAction(() => saveUser(draft.value));   // zero-arg closure — the natural sigx write

// fire-and-forget — safe; the UI reads save.loading / save.error
<button disabled={save.loading} onClick={() => save.run()}>Save</button>

// chaining — explicit, no try/catch
onClick={async () => { if ((await save.run()).ok) user.refresh(); }}
```

- **Write-retry, pinned:** `match`'s `error` arm on a write hands out `retry`
  = re-run with the **last input**. The arm is unreachable before the first
  run (state is `idle`), so "no last input" cannot occur.
- **Repeated `.run` while in flight:** abort-and-supersede (§1's one rule).
- **Actions keep `value` and `match`** deliberately: a search box is a
  manual-trigger async value whose `ready` arm renders results — writes and
  "deferred reads" blur, which is why both sides of the pair share one shape.
- **Cross-read invalidation is explicit:** the write's success path calls the
  dependent read's `user.refresh()`. Cache-aware `invalidate()` arrives with
  the cache **pack** (§7). No implicit graph.
- **No optimistic apply/rollback in core** — optimistic writes are a cache
  write-through and ship with the pack (§7); shipping them first would invent
  semantics the pack must redefine.
- **Why `useAction` is in core at all** (the honest borderline): it is ~50
  policy-free lines — but it is the *interface a cache pack needs*. Without a
  blessed write shape, a pack cannot retrofit invalidation and optimistic
  semantics onto N hand-rolled `signal(false)` idioms. Mechanism in core so
  policy can attach. (Confirmation is open question 1.)

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
  combined value, `error` on first failure.
- **`.errors`, specified:** object form ⇒ `Record<key, Error | null>` (same
  keys as the input); tuple form ⇒ a tuple of `Error | null` aligned with the
  inputs. First-error-wins on `.error`; `.errors` is the collect-all — no
  second API.
- **`all()` is only for all-or-nothing gating.** Partial loading ("show the user
  now, spinner while posts load") needs no `all` and no new API — the caller still
  holds each value, so compose `user.match(...)` and `posts.match(...)`
  independently.

### 4. Errors — at the value; one app handler; one scoped boundary

- **Data/async errors** → `match`'s `error` arm; `retry` is `refresh()` (reads)
  or re-run-last-input (writes). Omitting the arm renders `null` and **bubbles
  the error** to the nearest `errorScope` / app `onError` (never silently
  swallowed); a dev-mode warning fires the first time so the bubble is
  discoverable rather than a blank slot.
- **App-level handler** → surface the existing `app.config.errorHandler` (which
  already routes setup + render-effect errors via `handleComponentError`) as app
  `onError` — the catch-all for anything unhandled below. Surfacing it is not a new
  capability, but **Phase 1 additionally wires DOM event-handler throws through it**:
  today `runtime-dom` invokes event handlers directly with no `try/catch`, so a
  throw inside an `onClick` bypasses `handleComponentError` entirely.
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

  **Isolating one widget — the migration pattern, shown honestly.** Because
  `errorScope` scopes the *calling component's* subtree, isolating a single
  widget means wrapping it in a component. This is the one place migration
  from nested `<ErrorBoundary>` gains a line of ceremony (components are
  cheap in sigx; there is still no magic wrapper):

```tsx
const SafeWidget = component(() => {
  errorScope({ fallback: (e, retry) => <WidgetErr e={e} onRetry={retry}/> });
  return () => <Widget/>;
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
is the only wrapper component in the design. (Its *hydration* axis is being
designed in the SSR platform RFC, signalxjs/core#171 — out of scope here.)

### 6. SSR integration (preserve)

- Keyed `useData` (the shipped keyed `useAsync`) already serializes/streams
  via the `_useAsync`/`_useStream` seams (seam property names are existing
  internals and unchanged); `match` renders the `ready` arm server-side once
  the keyed value resolves.
- **Unkeyed `useData` is client-only by definition:** it renders the `pending`
  arm server-side and fetches after hydration — a visible pending→ready swap.
  This is documented behavior, not a bug; the fix is "add a key". A one-time
  dev-mode note fires when an unkeyed read renders during SSR (same
  discoverability convention as the missing-`error`-arm warning).
- Actions (`useAction`) don't run during SSR.
- `<Defer>` is the only thing the streaming path keys off (`render-core.ts`
  `__suspense` → `handleAsyncSetup` / `onAsyncComponentResolved` / `_pendingAsync`).
- Streaming, islands, keyed transfer, `blocking`/`stream` modes unchanged.

### 7. The cache pack contract (NOT core — the rev-4 scope cut)

Cache policy — `staleTime`, `gcTime`, revalidate-on-focus/interval,
`keepPreviousData`, cache-aware `invalidate()`, optimistic `mutate()` — is an
application-layer concern whose surface never stops growing (retry/backoff,
offline, persistence, devtools…). It does **not** ship in core. It ships as a
pack (name TBD — not "query", per `rfc-use-async.md`'s vocabulary decision;
open question 2). Core's only obligations are the seams that make the pack
possible:

1. **The provider seam.** The pack swaps/wraps the async engine per app the
   same way the server renderer already swaps `_useAsync` per request. This
   seam exists and is validated (`rfc-use-async.md` "Layering").
2. **The reserved options namespace.** Core's `AsyncOptions` reserves a
   `cache` key it never interprets; the pack claims it via module
   augmentation. The beginner signature stays `useData(key, fetcher)`;
   installing the pack changes one line (`app.use(cachePlugin())`), not the
   call sites:

```ts
const user = useData('user', fetchUser, {
  cache: { staleTime: 60_000, revalidateOnFocus: true },   // typed by the pack
});
user.invalidate();                  // pack-provided: drop entry + refetch
user.mutate(u => ({ ...u, name })); // pack-provided: optimistic write-through
```

3. **The blob-as-seed rule.** `__SIGX_ASYNC__` is the page's hydration data
   cache; the pack **adopts it as its initial cache state** rather than
   shipping a second one. (The SSR platform RFC #171 makes the serializer
   pluggable for the same reason.)
4. **The write interface.** `AsyncAction` (§2) is the shape the pack extends
   with optimistic apply + rollback.

One primitive, one vocabulary, unchanged call sites — but core carries
mechanism only, exactly like islands (`SSRPlugin`) and the store SSR adapter.
This is the line every peer draws: Solid's `createResource` stops where our
core phase stops; nobody ships `revalidateOnFocus` in a framework core.

### 8. Transitions — future work, evidence-driven (demoted from a phase)

Stale-hold already falls out of the model: `value` survives a refetch and
`match` keeps rendering `ready` during `refreshing`, which covers the common
no-flash case. A full `useTransition`/`startTransition`/`deferred` scheduler
is the least-validated idea in this document and is no longer a committed
phase — it returns as its own RFC if real apps demonstrate a need the
stale-hold doesn't cover.

### 9. Why not just TanStack Query?

The strongest form of the scope question: keep only the core phase and declare
the serious-app data story to be a TanStack Query adapter (its core is
framework-agnostic; an adapter + `dehydrate` for SSR is a modest pack).
Considered, and rejected as *the* answer:

- Its wrapper/hook vocabulary and snapshot-per-render model duplicate exactly
  what value-first replaces; two idioms for one job is the fragmentation this
  RFC exists to end.
- Keyed SSR streaming transfer with per-boundary flush needs framework
  cooperation either way — an adapter wouldn't remove the core work, only
  relocate the pack.
- But the *option* stays real: because the cache is a pack over a public seam
  (§7), a community TanStack adapter is just a different pack. Core doesn't
  have to pick the winner — that is the point of the seam.

## Layering — core vs SSR vs pack

Both primitives live in **core** (`sigx`), and neither is server-side.
The `rfc-use-async.md` rule decides it — *"runs standalone in a browser →
`sigx`; needs a server → `@sigx/server-renderer`"* — and both pass the
browser test (enforced by the client-bundle test):

| Layer | Package | Contributes |
|---|---|---|
| **Core** | `sigx` (runtime-core) | `useData` + `useAction` with their complete browser behavior (fetch on mount, reactive states, abort, `refresh`/`.run`); `match`/`all`; `lazy` + `<Defer>`; `errorScope` / app `onError`. A pure SPA uses all of it with zero server packages. |
| **SSR** | `@sigx/server-renderer` | *Attaches to* keyed `useData` via the provider seam (the `_useAsync` property check, per request): fetch on the server, dedupe, stream, serialize to `__SIGX_ASYNC__`, restore on hydration. Contributes **nothing** to `useAction` — actions never run during SSR. Core never imports server code. |
| **Cache pack** (future) | TBD (§7) | Policy: `staleTime`, revalidation, `invalidate`, optimistic `mutate` — extends both primitives through the §7 contract. Not part of core *or* the SSR package. |

The most common confusion, answered directly: `useAction` is the most
browser-only primitive in the design — its *only* SSR involvement is that it
does not run there.

## Removed vs renamed

- **Removed from core:** the throw-a-promise protocol, register-during-render
  ordering, the `<Suspense>` wrapper, `<ErrorBoundary>` as a flag-flip, the
  redundant `latest`, the standalone `when()` (covered by `match`), and —
  rev 4 — the entire cache/revalidation/optimistic layer (now the §7 pack
  contract) and transitions as a committed phase (§8).
- **Renamed / surfaced:** `app.config.errorHandler` → app `onError`; `<Stream>` →
  `<Defer>`.

## Phasing

- **Phase 0:** this document.
- **Phase 1 — Core foundation (the only core phase):** internal async-cell
  engine (rides `watch`); `useData` reads (renamed from `useAsync`; fused
  conditional key, one fetcher shape) + `match` + `refresh`; `useAction`
  writes (settled-result `.run`, `AsyncAction`); `all({...})` + `.errors`; rebuild
  `lazy()` + thin `<Defer>`; surface app `onError` (+ event-handler wiring);
  `errorScope` (pinned contract). Reserve the `cache` options namespace.
  Delete throw protocol, register-during-render boundary, old
  `Suspense`/`ErrorBoundary`, `latest`.
- **Phase 2 — The cache pack:** built against the §7 contract as its own
  program (home decided then — open question 2). Not a core deliverable;
  Phase 1 is complete without it.
- **Transitions:** no phase — future RFC if evidence demands (§8).

Each phase = its own issue → worktree → PR → Copilot review → merge.

## Resolved decisions

- Snapshot arm + diff-in-place, no live accessor (honesty note in §1).
- Arm names `pending`/`error`/`ready`; `match` is sugar at runtime,
  **load-bearing for types** (§1).
- Missing `error` arm ⇒ `null` + bubble to `onError` + first-time dev warning.
- `errorScope` ships Phase 1 with the §4 contract; the `SafeWidget` pattern is
  the nested-boundary migration.
- Keep both `state` and `loading`; no `isReady`/`isError`.
- `idle` via a falsy **getter** key only (`null`/`undefined`/`false`/`''`,
  with a dev warning on `''`) — no `enabled`/`skip` option.
- `all()` errors: first-error-wins + `.errors` (shapes pinned in §3).
- `<Defer>` (over `Stream`/`Await`); its hydration axis belongs to #171.
- Reads = `useData`, renamed from the shipped `useAsync` (rev 5 — post-split,
  "async" no longer carves read vs write; `useQuery`/`useResource`/
  `useAsyncData` rejected, see the header note).
- Writes = named `useAction` primitive (rev 5 — replaced `{ manual: true }`
  after the zero-arg-closure auto-fire footgun) with a distinct `AsyncAction`
  type; `.run` returns a settled `RunResult` (never rejects); retry = re-run
  last input; abort-and-supersede as the one concurrency rule.
- Layering: both primitives in core with full browser behavior; SSR attaches
  to keyed `useData` via the provider seam; `useAction` has no server
  behavior at all (see "Layering").
- Optimistic apply/rollback: pack, not core (arrives with the cache).
- `createAsyncCell`: stays internal — one public surface to stabilize pre-1.0.
- Unkeyed SSR behavior: documented client-only semantics + one-time dev note.
- **The rev-4 line: mechanism in core, policy in packs.** The cache layer is a
  pack contract (§7); transitions demoted (§8); the TanStack alternative
  dispatched (§9).

## Open questions

1. **Writes in Phase 1 core — confirm.** The §2 rationale (the write shape is
   the interface the cache pack needs) argues for core; the alternative is
   shipping reads-only and letting the pack own writes too. Cost of inclusion:
   ~50 policy-free lines. Cost of exclusion: N hand-rolled idioms the pack
   can't retrofit.
2. **Cache pack name and home** — not "query" (vocabulary rejected in
   `rfc-use-async.md`); candidates: `@sigx/cache`, `@sigx/data`. Own repo vs
   `packages/` in core (islands precedent: in-tree). Decided when Phase 2
   starts.
