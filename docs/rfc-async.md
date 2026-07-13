# RFC: value-first async — loading, lazy, errors; mechanism in core, policy in packs

Status: **proposed / under review — rev 6**. Tracking: signalxjs/core#135.
Pre-1.0, no-compat (same stance as `docs/rfc-use-async.md`): one way to do it.

> **rev-7 changes** (from the rev-6 follow-up review): the **reserved `cache`
> options key is dropped** — core pre-declaring a property it never reads was
> dead surface, at odds with sigx's own extension identity ("if it's in the
> types, it resolves"). Replaced by the mechanism §7 already implied: **open
> options interfaces** (the pack's own `.d.ts` augments `AsyncOptions`/
> `ActionOptions`, so the name exists exactly when the pack is in the
> project), **opaque options pass-through** (core hands the whole bag through
> the provider seam untouched — the real runtime contract), and a
> **default-engine unknown-option dev warning** (which subsumes most of the
> dev-stub requirement). Tuple-key hardening: non-finite numbers rejected in
> dev (`JSON.stringify(NaN)` → `"null"` would collide with actual `null`;
> `-0` canonicalizes to `0`); an **empty tuple is skipped + dev-warned**
> (like `''`); the **static-tuple form is rejected** — a tuple exists to
> carry parameters, and parameters that change belong in a getter (a static
> `['user', id.value]` invites exactly the stale-capture bug tuples were
> designed to eliminate; a constant tuple has no advantage over a constant
> string).

> **rev-6 changes** (from the rev-5 DX review on signalxjs/core#136): structured
> **tuple keys** (key/fetcher desync is the bug class string keys invite);
> `loading` narrowed to `state === 'pending'` only (the old definition
> re-created the skeleton flash on every revalidate); **key change ⇒ value
> cleared ⇒ `pending`** pinned (no wrong-data flash; `keepPreviousData` is pack
> policy); the concurrency rule split into two clauses (actions are **never
> aborted** in flight; shared keyed fetches can't be aborted by one consumer);
> `useAction` regains its **options slot** (the write half of the §7 contract
> needs an attachment point); promise contracts pinned (`refresh` never
> rejects; a superseded `.run` resolves `{ ok: false, error: SupersededError }`
> and never writes `.error`); the `error` arm receives the **last-good value**
> (`stale`) so a failed background refresh doesn't blank live content; `match`
> gains an optional **`idle` arm**; `<Defer>` observes pending **data and
> chunks** during SSR streaming (restoring the fallback-for-slow-data behavior
> `Suspense` had); §7 requires **dev-mode stubs** for pack methods; naming
> collisions acknowledged (`useAction`: Solid Router; `useData`: Vike); the
> **typed mock** is restored (`examples/spa-ssr/src/rfc-async-mock/`). Open
> question 1 (writes in core) resolved: **yes**.

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
> same name and signature). Known near-collisions, judged acceptable and
> owned here: `useAction` is Solid Router's mutation trigger and `useData` is
> Vike's page-data hook — both live at the router/meta-framework layer with
> different signatures; neither is a framework-core primitive. The shipped
> `useAsync` composable is renamed in place — pre-1.0, no-compat. Type names
> keep the `Async` prefix (`AsyncState`/`AsyncAction`/`AsyncOptions`) by
> decision, not oversight: they name the shared cell family, and combinators
> like `all()` return `AsyncState` regardless of source. One *concept*, one
> engine, a read/write pair — like `signal`/`computed`.

> **rev-4 changes (the scope cut):** core ships only what **only the framework
> can do** — the cache/revalidation/optimistic layer (rev-3 Phase 3) moves out
> of core entirely and becomes a **pack contract** over the existing provider
> seam (§7). Transitions (rev-3 Phase 2) are demoted from a committed phase to
> evidence-driven future work (§8). The TanStack alternative is addressed
> head-on (§9). DX decisions folded in: `.run` returns a settled result (never
> rejects); one fetcher shape everywhere (`(arg, ctx)`); writes get a distinct
> `AsyncAction` type; `match` reframed as "sugar at runtime, load-bearing for
> types"; write-retry pinned; `all().errors` specified; the scoped-isolation
> migration pattern shown. `createAsyncCell` stays internal (resolved).

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

> **Inspectable mock:** `examples/spa-ssr/src/rfc-async-mock/` contains a
> fully-typed mock of this surface (`use-data.ts`) plus usage examples
> (`examples.tsx`) exercising the overloads, tuple-key inference, `match`
> narrowing (incl. the `idle` arm and the `stale` error-arm parameter),
> `all()` object/tuple inference and `.errors`, and the `RunResult` contract.
> They typecheck against the example app's tsconfig and are not wired into
> the running app — same convention as `rfc-use-async.md`'s mock, and the
> acceptance gate for this surface before Phase 1.

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
`query()`; the engine stays internal — resolved). **One signature fuses the
reactive key, the fetcher's argument, and conditional fetching:**

```ts
type Falsy = null | undefined | false | '';   // '' included so `str && tuple` getters infer cleanly
type KeyTuple = readonly (string | number | boolean | null)[];  // primitives only (open question 2)
type KeyValue = string | KeyTuple;
type KeyResult = KeyValue | Falsy;                              // falsy ⇒ 'idle', don't fetch

type Fetcher<T, Arg> = (arg: Arg, ctx: { signal: AbortSignal }) => Promise<T>;

useData<T>(key: string, fetcher: Fetcher<T, string>, opts?): AsyncState<T>;    // keyed, SSR
useData<T, K extends KeyValue>(                                                // reactive key —
  key: () => K | Falsy, fetcher: Fetcher<T, K>, opts?): AsyncState<T>;         //   string or tuple
useData<T>(fetcher: Fetcher<T, undefined>, opts?): AsyncState<T>;              // unkeyed, client-only
useAction<T, In = void>(fn: Fetcher<T, In>, opts?: ActionOptions): AsyncAction<T, In>;  // write, §2
```

**One fetcher shape everywhere.** The fetcher's first argument is always *the
trigger's argument*: the resolved key for reads, the `.run(input)` value for
actions, `undefined` for unkeyed reads. One mental model — and it makes
overload disambiguation mechanical (two functions ⇒ the first is a key
getter; one function ⇒ it is the fetcher).

**Structured keys (rev 6).** The key does three jobs — reactive trigger,
cache/SSR identity, and the fetcher's input — and a template string does the
third badly, which corrupts the other two: parameters get closed over inside
the fetcher instead of encoded in the key, and a fetcher that reads
`sort.value` while the key omits it silently stops refetching on sort changes
*and* dedupes/serializes under an identity that doesn't include `sort`.
Key/fetcher desync is the most common bug class in keyed data fetching; the
tuple form eliminates it by making the key the *only* channel:

```tsx
const posts = useData(
  () => user.value && (['posts', userId.value, page.value, sort.value] as const),
  ([, uid, page, sort], { signal }) => fetchPosts(uid, page, sort, { signal }),
);
```

Core canonicalizes a tuple to its JSON string for identity (dedupe map,
`__SIGX_ASYNC__` blob key) — element order is meaningful and elements are
restricted to JSON primitives, so canonicalization is trivial and stable.
Dev-mode guards keep the canonical form honest (rev 7): **non-finite numbers
are rejected** (`JSON.stringify(NaN)` → `"null"`, silently colliding with an
actual `null` element; same for `±Infinity`; `-0` canonicalizes to `0`).
Plain strings stay for the simple case; **the static-tuple form
(`useData(['user', id], fetcher)`) is deliberately rejected** — a tuple
exists to carry parameters, and parameters that can change belong in a
getter; a static tuple invites the stale-capture bug tuples were designed to
eliminate, while a constant tuple has no advantage over a constant string.
Two load-bearing rules, stated explicitly: **the fetcher runs untracked** —
only the key getter is reactive; a signal read inside the fetcher does *not*
re-run anything. And **skip values:** the getter skips (state `'idle'`,
fetcher not run) on any falsy result — `null`, `undefined`, `false`, `''`
(dev-warned: an empty string usually means an interpolation bug) — **and on
an empty tuple** (skipped + dev-warned, rev 7: `[]` is truthy but is almost
always a bug; treating it like `''` keeps "no parameters yet ⇒ no fetch").

`AsyncState` — `state` is the canonical truth:

```ts
interface AsyncState<T> {
  readonly state: 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';
  readonly value: T | null;          // SWR last-good; kept across refresh(), CLEARED on key change
  readonly error: Error | null;      // normalized; mutually exclusive with value
  readonly loading: boolean;         // state === 'pending' ONLY — "nothing to show yet" (rev 6)

  match<R>(arms: {
    idle?:    () => R;                              // defaults to the pending arm (rev 6)
    pending?: () => R;                              // omitted ⇒ renders nothing while pending
    error?:   (e: Error, retry: () => void, stale: T | null) => R;   // stale = last-good (rev 6)
    ready:    (v: T) => R;                          // required: the happy path
  }): R | undefined;

  refresh(): Promise<void>;          // re-run in place; NEVER rejects — failures land on .error
}
```

**Pinned semantics (rev 6):**

- **`loading` means "nothing to show yet"** — `state === 'pending'` only.
  The blessed migration idiom `if (x.loading) return <Skeleton/>` stays
  correct: it never flashes a skeleton over live content during a background
  revalidate. Refresh indicators read `state === 'refreshing'` explicitly.
- **Key change ⇒ hard reset:** value cleared, state `pending`. Rendering
  user A's data under user B's key is a wrong-data flash — strictly worse
  than a skeleton. `value` is kept only across *same-key* `refresh()`
  (state `refreshing`). `keepPreviousData` stale-hold across key changes is
  exactly a `cache: {}` pack policy (§7).
- **A failed background refresh does not blank live content:** on error,
  top-level `value`/`error` stay mutually exclusive (matching shipped
  behavior), but the engine retains the last-good value internally and hands
  it to the error arm as `stale` — so "keep showing data, add a toast" is
  expressible with zero extra state. (This deliberately revises rev 2's
  "errored + value ⇒ render `ready`" — the *app* decides whether stale
  content survives an error, not the framework.)
- **`idle` is matchable:** conditional fetch is a headline feature, and
  "Type to search…" is not a spinner. The optional `idle` arm defaults to
  the `pending` arm, so simple cases stay two-arm.

**`match` is sugar at runtime, load-bearing for types.** Plain `state` checks
work (`if (x.loading) …`), but TypeScript cannot narrow `value: T | null`
across reactive getter reads — `ready: (v: T) => R` is the only *type-safe*
path to a non-null `T`. `match` also carries the error-bubbling guarantee
(an omitted `error` arm is never silently swallowed). Both are contract, not
convenience.

**State → arm mapping** (`match` is exactly this table):

| `state` | `value` | `match` renders |
|---|---|---|
| `idle` | null | the `idle` arm, else the `pending` arm, else nothing |
| `pending` | null | the `pending` arm, or nothing if it's omitted |
| `ready` / `refreshing` | present | `ready(value)` — live, stale-while-revalidating |
| `errored` | null | `error(e, retry, stale)`, or `null` + bubble to `onError` if no `error` arm |

**No `latest`, no flash, but honest about the model.** `value` already is the
SWR last-good value, so a separate `latest` is redundant (dropped). The `ready`
arm is a snapshot callback `(v) => JSX`; when `value` changes the arm
**re-executes and the renderer diff-patches its returned subtree against the
previous one** (`renderer.ts` `componentEffect` → `patch`) — no remount, no flash.
This is sigx's hybrid model: fine-grained *signals* drive coarse-grained
render-fn re-execution + a real vdom diff. It's cheap, but it is *not* Solid-style
targeted node update — the whole returned subtree is re-evaluated and re-diffed on
each change.

**Concurrency — two clauses, matching what ships (rev 6).** The shipped
engine shares one in-flight fetch per key across consumers, with the fetch's
abort signal deliberately detached from any single consumer
(`use-async.ts`) — so "a newer run aborts the old one" cannot literally hold
for shared fetches, and the in-flight dedupe map is **kept** by this design:

- **Reads:** on key change or `refresh()`, the *cell* stops observing the
  superseded run (its result is discarded; it never writes state). The
  underlying fetch is aborted only when unshared (sole consumer). A
  superseded run never writes `.error`.
- **Actions:** see §2 — a newer `.run` supersedes *observation only*;
  in-flight requests are **never aborted**.

The engine rides `watch` (which has `onCleanup`) + `AbortController` for the
unshared-abort case.

### 2. Writes — `useAction`

A write is the same reactive async cell with a manual trigger: it never
auto-runs, and exposes `.run(input)`. It is a **named primitive** (not a
`useData` option — see the rev-5 note: a zero-arg write closure would make a
forgotten option compile clean and auto-fire the mutation on mount) and
returns a distinct type:

```ts
type RunResult<T> = { ok: true; value: T } | { ok: false; error: Error };
class SupersededError extends Error {}          // exported; identifies discarded runs

interface ActionOptions {}  // OPEN interface — deliberately empty in core (rev 7).
// A pack augments it (declare module …) so its options exist in the editor
// exactly when the pack is in the project; core passes the whole bag through
// the provider seam untouched (§7). Same for AsyncOptions on reads.

interface AsyncAction<T, In> {
  readonly state: 'idle' | 'pending' | 'ready' | 'errored';   // no 'refreshing'
  readonly value: T | null;          // last successful result
  readonly error: Error | null;
  readonly loading: boolean;         // state === 'pending'
  match<R>(arms: { /* same arms as AsyncState; retry = re-run last input */ }): R | undefined;
  run(input: In): Promise<RunResult<T>>;   // In = void ⇒ zero-arg run(): TS permits
}                                          // omitting a void-typed parameter. No refresh().

useAction<T, In = void>(fn: Fetcher<T, In>, opts?: ActionOptions): AsyncAction<T, In>;
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

- **In-flight actions are never aborted (rev 6).** An aborted POST is not an
  undone POST — the server may commit anyway, and the app would never see
  the result. A newer `.run` while one is in flight supersedes *observation*:
  the older run's result is discarded, it never writes state, and its
  promise resolves `{ ok: false, error: SupersededError }`. The blessed
  double-submit guard is `disabled={save.loading}` — shown above, and shown
  deliberately.
- **Promise contracts, pinned (rev 6):** a superseded or unmounted-out run
  never writes `.error` (superseded ≠ failed); its `RunResult` carries
  `SupersededError` so a chaining caller can distinguish. `refresh()` on a
  read likewise **never rejects** — `onClick={() => user.refresh()}` must
  not be the footgun `.run` just fixed.
- **Write-retry:** `match`'s `error` arm on an action hands out `retry` =
  re-run with the **last input**. The arm is unreachable before the first
  run (state `idle`). Note the call-style nuance: with `run(input)`, retry
  re-submits the *captured* input (a stale-draft hazard for forms); with the
  zero-arg-closure style, retry re-reads current signal values. Both are
  correct; the doc calls it out so form authors pick deliberately.
- **Actions keep `value` and `match`** deliberately: a search box is a
  manual-trigger async value whose `ready` arm renders results — writes and
  "deferred reads" blur, which is why both sides of the pair share one shape.
- **Cross-read invalidation is explicit:** the write's success path calls the
  dependent read's `user.refresh()`. Cache-aware `invalidate()` arrives with
  the cache **pack** (§7). No implicit graph.
- **No optimistic apply/rollback in core** — optimistic writes are a cache
  write-through and ship with the pack (§7); the per-action policy attaches
  through the pack's augmentation of `ActionOptions`.
- **Why `useAction` is in core at all**: it is ~50 policy-free lines — but it
  is the *interface a cache pack needs*. Without a blessed write shape, a
  pack cannot retrofit invalidation and optimistic semantics onto N
  hand-rolled `signal(false)` idioms. Mechanism in core so policy can attach.
  (Resolved: ships in Phase 1 — see Resolved decisions.)

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
- Returns a derived `AsyncState`: `pending` until all first settle, `ready`
  with the combined value, `error` on first failure.
- **Derived-state rules (rev 6):** while every member has a value and any
  member is `refreshing`, the combined state is `refreshing` (combined
  `ready` arm keeps rendering — consistent with SWR). The combined
  `refresh()` refreshes **all members** in parallel and settles when they
  do (never rejects, like any `refresh`). `idle` members hold the combined
  state at `idle` — gate with a conditional key upstream instead.
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
  or re-run-last-input (actions). Omitting the arm renders `null` and **bubbles
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
  **setup-time call inside a component that scopes that component's own subtree**.
  It provides a handler via DI; as **Phase-1 wiring** (not current behavior —
  today `handleComponentError` checks only plugin hooks + `config.errorHandler`),
  `handleComponentError` gains a walk of the instance parent chain via the
  existing `lookupProvided` traversal before falling through to the app
  handler. On a throw from the component's render or a descendant's
  render/effect, the component renders `fallback(e, retry)` **instead of**
  its normal output; `retry` tears down and rebuilds the subtree
  (`effectScope.stop()` + remount), not a flag flip.

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

`<Defer>` reads pending state reactively — no throw, no register-during-render
ordering — and is the boundary the streaming machinery keys off (`__suspense`
marker → flush fallback now, stream real markup later). It is the only wrapper
component in the design. **What it observes differs by environment (rev 6):**

- **During SSR streaming, `<Defer>` observes *anything* pending beneath it —
  code chunks *and* keyed `useData` cells.** A slow keyed read inside a
  `<Defer>` streams the fallback and gets replaced when the data resolves,
  exactly as `Suspense` + `_pendingAsync` behaves today. (Without this, a
  slow keyed read would block the stream with no fallback and no flush
  point — a silent regression the rev-5 review caught.) Blocking/string
  modes await inline as today.
- **On the client, `<Defer>`'s fallback covers chunk loading only.** Data
  pending states render through the owning component's `match` — component-
  local, where the design puts them. This split means the two fallback
  mechanisms never compete for the same state.

(Its *hydration* axis is being designed in the SSR platform RFC,
signalxjs/core#171 — out of scope here.)

### 6. SSR integration (preserve)

- Keyed `useData` (the shipped keyed `useAsync`) already serializes/streams
  via the `_useAsync`/`_useStream` seams (seam property names are existing
  internals and unchanged); `match` renders the `ready` arm server-side once
  the keyed value resolves. Tuple keys serialize under their canonical JSON
  string in the same blob.
- **Unkeyed `useData` is client-only by definition:** it renders the `pending`
  arm server-side and fetches after hydration — a visible pending→ready swap.
  This is documented behavior, not a bug; the fix is "add a key". A one-time
  dev-mode note fires when an unkeyed read renders during SSR (same
  discoverability convention as the missing-`error`-arm warning).
- Actions (`useAction`) don't run during SSR.
- `<Defer>` is the only thing the streaming path keys off (`render-core.ts`
  `__suspense` → `handleAsyncSetup` / `onAsyncComponentResolved` / `_pendingAsync`),
  now observing pending data as well as chunks (§5).
- Streaming, islands, keyed transfer, `blocking`/`stream` modes unchanged.

### 7. The cache pack contract (NOT core — the rev-4 scope cut)

Cache policy — `staleTime`, `gcTime`, revalidate-on-focus/interval,
`keepPreviousData`, cache-aware `invalidate()`, optimistic `mutate()` — is an
application-layer concern whose surface never stops growing (retry/backoff,
offline, persistence, devtools…). It does **not** ship in core. It ships as a
pack (recommended: `@sigx/cache`, in-tree — see open question 1). Core's only
obligations are the seams that make the pack possible:

1. **The provider seam.** The pack swaps/wraps the async engine per app the
   same way the server renderer already swaps `_useAsync` per request. This
   seam exists and is validated (`rfc-use-async.md` "Layering").
2. **Open options interfaces + opaque pass-through — on both primitives
   (rev 7; replaces the reserved-key mechanism).** `AsyncOptions`/
   `ActionOptions` contain only options core actually reads. The pack's own
   `.d.ts` augments them —
   `declare module '@sigx/runtime-core' { interface AsyncOptions { cache?: CacheOptions } }` —
   so `cache` exists in the editor exactly when the pack is in the project,
   and it is the *pack's* name, not core's (the same pattern as JSX attribute
   augmentation: if it's in the types, it resolves). The runtime obligation
   is **pass-through**: core hands the *whole* options bag through the
   provider seam untouched — never validates, strips, or copies
   known-keys-only. Inter-pack collisions are a **compile error** under
   declaration merging; by convention a pack nests all its options under a
   single key named for its domain. (The reservation's one selling point —
   a beginner seeing `cache?` in autocomplete on a bare install — was an
   anti-feature: autocomplete advertising a no-op.) The beginner signature
   stays `useData(key, fetcher)`; installing the pack changes one line
   (`app.use(cachePlugin())`), not the call sites:

```ts
const user = useData('user', fetchUser, {
  cache: { staleTime: 60_000, revalidateOnFocus: true },   // typed by the pack's augmentation
});
user.invalidate();                  // pack-provided: drop entry + refetch
user.mutate(u => ({ ...u, name })); // pack-provided: optimistic write-through
```

3. **The blob-as-seed rule.** `__SIGX_ASYNC__` is the page's hydration data
   cache; the pack **adopts it as its initial cache state** rather than
   shipping a second one. (The SSR platform RFC #171 makes the serializer
   pluggable for the same reason.)
4. **The write interface.** `AsyncAction` (§2) is the shape the pack extends
   with optimistic apply + rollback, attached per-action via its augmented
   options (e.g. `cache`).
5. **Unknown-option dev warning (rev 7; shrinks the rev-6 stub
   requirement).** The default engine runs only when no pack replaced it, so
   any option key it doesn't own is unhandled *by definition*. In dev it
   warns: *"[useData] option 'cache' was passed but no installed plugin
   handles it — did you forget `app.use(cachePlugin())`?"* This is generic
   over every pack's options, and it covers the types-without-runtime gap at
   the option site (packs own the diagnostics for their augmented *methods*;
   in TS, unaugmented options are already a compile error thanks to
   excess-property checks on the open interfaces).

One primitive family, one vocabulary, unchanged call sites — but core carries
mechanism only, exactly like islands (`SSRPlugin`) and the store SSR adapter.
This is the line every peer draws: Solid's `createResource` stops where our
core phase stops; nobody ships `revalidateOnFocus` in a framework core.

### 8. Transitions — future work, evidence-driven (demoted from a phase)

Stale-hold already falls out of the model: `value` survives a same-key
refetch and `match` keeps rendering `ready` during `refreshing`, which covers
the common no-flash case. A full `useTransition`/`startTransition`/
`deferred` scheduler is the least-validated idea in this document and is no
longer a committed phase — it returns as its own RFC if real apps demonstrate
a need the stale-hold doesn't cover.

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
| **Cache pack** (future) | recommended `@sigx/cache` (§7) | Policy: `staleTime`, revalidation, `invalidate`, optimistic `mutate` — extends both primitives through the §7 contract. Not part of core *or* the SSR package. |

The most common confusion, answered directly: `useAction` is the most
browser-only primitive in the design — its *only* SSR involvement is that it
does not run there.

## Removed vs renamed

- **Removed from core:** the throw-a-promise protocol, register-during-render
  ordering, the `<Suspense>` wrapper, `<ErrorBoundary>` as a flag-flip, the
  redundant `latest`, the standalone `when()` (covered by `match`), and —
  rev 4 — the entire cache/revalidation/optimistic layer (now the §7 pack
  contract) and transitions as a committed phase (§8).
- **Renamed / surfaced:** `useAsync` → **`useData`** (rev 5 — the largest
  user-visible rename in the proposal); `app.config.errorHandler` → app
  `onError`; `<Stream>` → `<Defer>`.
- **Changed shape (the largest mechanical migration):** the fetcher signature
  goes from `(ctx) => Promise<T>` to **`(arg, ctx) => Promise<T>`** — every
  existing keyed `useAsync` call site gains the leading key argument (or
  ignores it: `(_, { signal }) => …`).

## Phasing

- **Phase 0:** this document + the typed mock
  (`examples/spa-ssr/src/rfc-async-mock/`) as the surface's acceptance gate.
- **Phase 1 — Core foundation (the only core phase):** internal async-cell
  engine (rides `watch`; keeps the shipped in-flight dedupe map); `useData`
  reads (renamed from `useAsync`; string + tuple keys, fused conditional key,
  one fetcher shape, pinned key-change/refresh semantics) + `match` (incl.
  `idle` arm + `stale` error param) + `refresh`; `useAction` writes
  (settled-result `.run`, `SupersededError`, `ActionOptions`, no-abort rule);
  `all({...})` + `.errors` + derived-state rules; rebuild `lazy()` + thin
  `<Defer>` (SSR: observes data + chunks; client: chunks only); surface app
  `onError` (+ event-handler wiring) and the `errorScope` parent-chain walk;
  options flow through the provider seam whole + default-engine
  unknown-option dev warning. Delete throw protocol,
  register-during-render boundary, old `Suspense`/`ErrorBoundary`, `latest`.
- **Phase 2 — The cache pack:** built against the §7 contract as its own
  program (recommended `@sigx/cache`, in-tree; final call when Phase 2
  starts). Not a core deliverable; Phase 1 is complete without it.
- **Transitions:** no phase — future RFC if evidence demands (§8).

Each phase = its own issue → worktree → PR → Copilot review → merge.

## Resolved decisions

- Snapshot arm + diff-in-place, no live accessor (honesty note in §1).
- Arm names `idle`/`pending`/`error`/`ready`; `match` is sugar at runtime,
  **load-bearing for types** (§1); `idle` arm optional, defaults to `pending`.
- Missing `error` arm ⇒ `null` + bubble to `onError` + first-time dev warning.
- `errorScope` ships Phase 1 with the §4 contract (parent-chain walk is
  Phase-1 wiring, not current behavior); the `SafeWidget` pattern is the
  nested-boundary migration.
- Keep both `state` and `loading`; **`loading = state === 'pending'` only**
  (rev 6). No `isReady`/`isError`.
- `idle` via a falsy **getter** key only (`null`/`undefined`/`false`/`''`,
  dev warning on `''` and on empty tuples) — no `enabled`/`skip` option.
- **Structured tuple keys** (rev 6): `readonly (string|number|boolean|null)[]`,
  canonical-JSON identity, tuple passed to the fetcher; the fetcher runs
  **untracked**.
- **Key change ⇒ value cleared ⇒ `pending`** (rev 6); SWR keep applies to
  same-key `refresh()` only; `keepPreviousData` is pack policy.
- **Errored keeps content expressible**: `error` arm receives `stale: T | null`
  (rev 6); top-level `value`/`error` stay mutually exclusive.
- `all()` errors: first-error-wins + `.errors` (shapes pinned in §3);
  combined `refresh()` refreshes all members; any-member-refreshing ⇒
  combined `refreshing`.
- `<Defer>` (over `Stream`/`Await`); SSR: observes pending data + chunks;
  client fallback: chunks only (rev 6); its hydration axis belongs to #171.
- Reads = `useData`, renamed from the shipped `useAsync` (rev 5); naming
  collisions with Solid Router's `useAction` / Vike's `useData` acknowledged
  and accepted (different layer + signature); type names keep the `Async`
  prefix by decision.
- Writes = named `useAction(fn, opts?)` primitive with a distinct
  `AsyncAction` type; `.run` returns a settled `RunResult` (never rejects);
  superseded runs resolve `SupersededError` and never write `.error`;
  **in-flight actions are never aborted** — `disabled={loading}` is the
  double-submit guard; retry = re-run last input (call-style nuance
  documented).
- `refresh()` never rejects (errors land on `.error`).
- Concurrency: two clauses (§1) — supersede observation; abort only unshared
  read fetches; the in-flight dedupe map is kept.
- Optimistic apply/rollback: pack, not core; per-action policy attaches via
  the pack's augmentation of `ActionOptions`.
- Pack options mechanism (rev 7): **open interfaces + opaque pass-through +
  default-engine unknown-option dev warning** — no reserved keys, no core
  stubs; core's options interfaces contain only what core reads.
- Tuple-key hardening (rev 7): non-finite numbers dev-rejected; empty tuple
  skipped + dev-warned (like `''`); static-tuple form rejected (stale-capture
  bug; a constant tuple has no advantage over a constant string).
- `createAsyncCell`: stays internal — one public surface to stabilize pre-1.0.
- Unkeyed SSR behavior: documented client-only semantics + one-time dev note.
- **Writes ship in Phase 1 core** (was open question 1): ~50 policy-free
  lines, and `AsyncAction` is the seam the cache pack extends — which is why
  the rev-6 concurrency and options fixes had to land before this contract
  is pinned.
- **The rev-4 line: mechanism in core, policy in packs.** The cache layer is a
  pack contract (§7); transitions demoted (§8); the TanStack alternative
  dispatched (§9).

## Open questions

1. **Cache pack home/timing** — name recommendation is settled
   (`@sigx/cache`; `@sigx/data` would collide with `useData`), in-tree per
   the islands precedent; formal confirmation when Phase 2 starts.
2. **Tuple key elements** — primitives-only (proposed: identity stays
   trivial canonical JSON; no reference-vs-value confusion) vs arbitrary
   serializable values with structural hashing later. Widening is
   non-breaking; narrowing is not — hence the conservative start.
