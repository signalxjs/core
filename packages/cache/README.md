# @sigx/cache

Cache **policy** for SignalX's value-first async — `staleTime`, `gcTime`,
focus/interval revalidation, `keepPreviousData`, cache-aware `invalidate()`,
and optimistic `mutate()` — riding the `rfc-async` §7 pack contract. Core
carries mechanism only; this pack is a drop-in equal of any third-party pack,
with zero privileged access.

Installing it changes one line, not your call sites:

```ts
import { cachePlugin } from '@sigx/cache';

app.use(cachePlugin({ staleTime: 30_000 }));   // app-wide defaults (optional)
```

```tsx
// The `cache` option exists on useData/useAction exactly when this pack is
// in the project (module augmentation of core's open interfaces):
const user = useData('user', fetchUser, {
    cache: { staleTime: 60_000, revalidateOnFocus: true },
});

user.invalidate();                    // drop the entry + refetch everywhere
user.mutate(u => ({ ...u, name }));   // optimistic write-through

const save = useAction(saveUser, {
    cache: {
        invalidates: [['users']],     // tuple PREFIX: hits every ['users', …] read
        // Annotate apply's params to type them — `current` is the TARGET
        // read's cached state, unknowable to the action's own types.
        optimistic: { key: 'user', apply: (current: User | undefined, next: User) => next },
    },
});
```

## What it does

- **`staleTime`** — a fresh cached value is served without fetching; a stale
  one is served immediately and revalidated in the background (state
  `'refreshing'` — your `match` keeps rendering the ready arm).
- **`gcTime`** — entries are retained after the last consumer unmounts
  (default 5 minutes), so navigation back is instant.
- **`revalidateOnFocus` / `revalidateOnInterval`** — mounted reads refetch on
  window focus/visibility or on a timer.
- **`keepPreviousData`** — across a key change with nothing cached for the new
  key, the previous key's value keeps rendering (state `'refreshing'`) instead
  of core's hard reset. Pagination without skeleton flashes.
- **`invalidate()`** (on reads and via action `invalidates`) — drop freshness
  and refetch for every mounted consumer. Action patterns accept exact keys or
  tuple prefixes.
- **`mutate()` / `optimistic`** — write through the cache immediately (every
  mounted consumer re-renders); a failed action run rolls back, unless
  something newer wrote to the entry meanwhile.

## Semantics it inherits, not invents

- Reads and actions **without** a `cache` option keep core's default-engine
  behavior verbatim (the pack delegates).
- Keys are core's canonical identities (strings; tuples as canonical JSON) —
  the store and core's SSR blob speak the same language.
- **SSR/hydration**: the pack adopts `window.__SIGX_ASYNC__` as its *initial*
  cache state (§7 blob-as-seed) — server-fetched values hydrate as fresh
  entries and nothing refetches on load. Server rendering itself is untouched
  (the SSR provider seam outranks any engine).
- Core's pinned rules hold: `loading === (state === 'pending')`, value/error
  mutual exclusion, `refresh()`/`run()` never reject, actions never aborted.

## Renderer portability

The pack depends on `@sigx/runtime-core` + `@sigx/reactivity` only — never
the `sigx` umbrella — so it loads and works on any renderer (web,
[lynx](https://github.com/signalxjs/lynx),
[terminal](https://github.com/signalxjs/terminal)). Two platform notes:

- Windowless client runtimes must declare themselves live clients once —
  their platform module calls `declareLiveClient()` from
  `@sigx/runtime-core/internals` (a renderer concern, not an app one; the
  web needs nothing).
- Focus revalidation's *event source* is pluggable: the default subscribes
  to window focus + `visibilitychange` (installed only when a DOM is
  present). Elsewhere, hand the plugin your platform's attention event:

```ts
app.use(cachePlugin({
    revalidateTrigger: (revalidate) => {
        const off = platform.onResume(revalidate); // lynx app-resume, terminal focus, …
        return off;                                // runs on app teardown
    },
}));
```

Reads still opt in per call site via `revalidateOnFocus`.

## Typed views

`useData(...)` keeps returning `AsyncState<T>`; the augmentation adds
`invalidate?()` and a loosely-typed `mutate?()`. For precise typing of a read
you know is cached, use the exported view:

```ts
import type { CachedAsyncState } from '@sigx/cache';
const user = useData('user', fetchUser, { cache: {} }) as CachedAsyncState<User>;
```

## Full docs

Guides and API reference → **<https://sigx.dev/>**
