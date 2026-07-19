# RFC: single-flight boundary refresh — mutation + fresh UI in one request

Status: **proposed**. Tracking: signalxjs/core#313. Pre-1.0, no-compat (same
stance as `rfc-async.md`, `rfc-ssr-platform.md`, `rfc-server.md`,
`rfc-deploy.md`): one way to do it.

This RFC promotes `rfc-server.md` §6.3 from a reserved sketch to committed
design. §6.3 stays the origin (it is why the v1 envelope already reserves
`$boundaries`); everything below is the full design the sketch deferred.

Relationship to the other RFCs:

- **Cashes the `$boundaries` check `rfc-server.md` wrote.** v1 reserved the
  envelope field `$boundaries` and the §7 note "single-flight boundary refresh
  (6.3) once the envelope and the per-request re-render path are proven." The
  envelope is stable (serverStream #310, `$cache` #311 shipped on it); this is
  the promised follow-up.
- **Unifies with `$cache` (`rfc-server.md` §6.2, shipped #311), does not
  compete with it.** The one declaration that drives everything here is the
  *already shipped* `serverFn({ invalidates })` cache directive. `$cache` names
  data that changed; this RFC makes the *same names* additionally deliver fresh
  server-rendered UI for the boundaries that read that data and cannot cheaply
  refetch (resumed, never-hydrated boundaries), and fresh *values*
  (`$cache.set`) for the live cache subscribers that can. No new developer
  surface.
- **Rides `@sigx/resume`'s boundary model and `@sigx/cache`'s key model**
  through the established pack-to-pack seams (`globalThis.__SIGX_SERVERFN_*`),
  exactly as `$cache` bridges `@sigx/server` ↔ `@sigx/cache` today. `@sigx/server`
  learns nothing new about components; `@sigx/server-renderer` core learns
  nothing new about RPC.
- **Stays a pack composition.** No core option bags, no wrapper components — the
  sigx way (`AGENTS.md`, and the `feedback_pluggable_over_core_options` /
  `no_query_extend_useasync` principles). A mutation is a `serverFn`; a refresh
  is a consequence, not an API.

## Problem — stated against the current code

`@sigx/resume` ships **resumed, never-hydrated** boundaries: a component that
rendered on the server, has its state captured (`SSRBoundaryRecord.state`,
`packages/server-renderer/src/boundary.ts`), and on the client is represented
only by an `InternalScope` in the `scopes` map (`packages/resume/src/client/
scope.ts`) — no component code has run, no chunk has loaded. A read-only handler
resumes against `scope._values` and never triggers upgrade-on-write, so the
chunk stays unloaded. This is the whole point: interactive pages that ship
hundreds of bytes.

Now a mutation changes data that such a boundary reads. Today the only tool is
`$cache` invalidation (#311): the client `invalidate(['cart'])` marks the cache
stale. But a resumed boundary **is not subscribed on the client** — its
`useData(['cart'])` ran at SSR, not in the browser; there is no mounted cell in
`CacheStore.subscribers` (`packages/cache/src/store.ts`) to react. To reflect
the change, that boundary would have to **upgrade** — load its chunk, hydrate,
re-run `useData`, refetch over the network. A second round-trip, and the exact
chunk load resumability existed to avoid, spent to move a number.

Meanwhile the server just rendered the whole app for this user seconds ago and
knows precisely how to render that boundary. The mutation response is a wasted
opportunity: it carries `data` (and now `$cache`) but not the one thing the
server is uniquely positioned to give cheaply — the fresh boundary itself.

The competition frames the ceiling. Qwik has no server-single-flight for
resumed components at all (it would resume the component to run it). Solid's
single-flight mutations re-run the **whole route loader** and diff. Neither
patches a dormant, never-hydrated component's pixels from a mutation response
without waking it. sigx's boundary model can — that is what this RFC builds.

## Design in one sentence

A mutation's already-declared `invalidates` keys, intersected against the cache
keys each live boundary captured at SSR, select the **resumed** boundaries the
server surgically re-renders and piggybacks back as `$boundaries` patches
(`{id, html, state}`) — the resume runtime applies them by DOM surgery (chunk
never loads) —
while the fresh key values captured during that re-render ride back as
`$cache.set`, so every **hydrated** subscriber updates through the cache's
normal reactivity (no refetch, no stale-props re-render).

## 1. Developer surface — nothing new

The complete authoring surface is the `invalidates` directive that shipped in
#311. It names **data keys, never components** — this is a hard constraint:
`serverFn` is backend logic and must not know a `CartBadge` exists.

```tsx
// cart.server.ts — unchanged from #311, component-agnostic
export const addToCart = serverFn({
  input: v.object({ id: v.string() }),
  handler: (ctx, { id }) => db.cart.add(id),
  invalidates: ({ id }) => [['cart']],      // data keys only
})

// CartBadge.tsx — a resumed island (client:idle), reads cart at SSR
const CartBadge = component((ctx) => {
  const cart = useData(['cart'], loadCart)   // read at SSR ⇒ boundary subscribes to ['cart']
  return () => <span>{cart.value.count}</span>
})

// <button onClick={() => addToCart({ id })}>Add</button>
```

Calling `addToCart` is **one request** that returns `data`, invalidates
`['cart']`, and — because `CartBadge` is a resumed boundary that read `['cart']`
— carries its fresh HTML+state back and patches the badge. The chunk never
loads. The developer wrote nothing about UI refresh.

The same `invalidates` declaration produces the *optimal* behavior per boundary
state, decided at runtime, not authoring time:

| Boundary state (client) | Reads an invalidated key | Behavior |
|---|---|---|
| **resumed** (never hydrated) | yes | server single-flight → DOM surgery, **no chunk load** |
| **upgraded** (hydrated) | yes | fresh value pushed as `$cache.set` → cache entry updated, live cells re-render (**no refetch, no re-render with stale props**) |
| **not refreshable** (`refreshable:false`) | yes | excluded from single-flight → falls back to `$cache` invalidation (#311) |
| any | no | untouched |

Note the upgraded row: the server does **not** ship boundary HTML or a state
snapshot at a hydrated component. Its SSR-era descriptor may be stale (a cache
key derived from a client signal, local-only UI signals) and a snapshot write
could clobber newer client state. Instead the fresh **data values** captured
during the surgical re-render ride back keyed by cache key (`$cache.set`, §2.1),
and the live cache subscription — the thing an upgraded boundary reliably has —
propagates them. Data flows through the same one pipe it always does.

The one opt-out is `refreshable: false` (§5), for boundaries whose correctness
depends on non-serializable, request-scoped DI the server cannot reconstruct in
isolation. Those decline and ride the existing `$cache` path. It is an opt-out,
not an opt-in — refresh is the default consequence of a correct `invalidates`.
The opt-out is declared where the boundary is declared — at the island usage
site, beside the `client:*` directive (exact spelling is an open question;
candidate: a `refresh={false}` attribute handled by the same transform) — and
lands as `SSRBoundaryRecord.refreshable: false` (§2.3), which is the contract;
the attribute is pack sugar over it.

## 2. Wire contract

### 2.1 Response envelope — the reserved `$boundaries`

The success envelope (built in `handleServerFnRequest`,
`packages/server/src/server/index.ts`) gains `$boundaries` beside the existing
`data`/`$cache`:

```jsonc
200 {
  "data": { /* mutation result */ },
  "$cache": {
    "invalidates": [["cart"]],                      // #311, unchanged
    "set": { "[\"cart\"]": { "count": 3 } }         // NEW: fresh values, canonical key → value
  },
  "$boundaries": {
    "seq": 12,                                      // echo of the manifest's seq (§5.3)
    "patches": [
      { "id": 7, "html": "<span>3</span>", "state": { "count": 3 } }
    ]
  }
}
```

(The §6.3 sketch reserved `$boundaries` as a bare array; the committed shape
wraps it with `seq` for the §5.3 ordering guard — free to refine, since the
field was reserved-and-ignored in v1.)

`$boundaries` carries **resumed** boundaries only. `id` is the **client's**
boundary id, carried round-trip (§4.3) — the client patches DOM by it. `html`
is the freshly rendered content root. `state` is the freshly captured
signal-state snapshot (the same `serializeSignalState` output that becomes
`SSRBoundaryRecord.state`).

`$cache.set` is the hydrated-subscriber half: the canonical-key → fresh-value
pairs the surgical re-render captured along the way (`SSRContext._asyncResults`
already holds exactly this map — key capture and value capture are the same
walk, §3). The client cache writes each entry as fresh (`updatedAt = now`);
every mounted cell subscribed to that key re-renders through normal reactivity.
No boundary descriptor, no props, no snapshot — hydrated components get *data*,
not UI. A key in `set` is thereby already satisfied and is **not** re-processed
from `invalidates` (§5.2).

### 2.2 Request manifest — how the server learns the live boundaries

`serverFn` cannot name boundaries, and the server holds no session across the
document GET and the mutation POST — so the **client** supplies the live
boundary descriptors, in the request body beside `args`:

```jsonc
POST /_sigx/fn/addToCart_fn_9f3a01cc
{
  "args": [{ "id": "sku-42" }],
  "$refresh": {
    "seq": 12,                                   // client-owned ordering (§5.3)
    "boundaries": [
      { "id": 7, "token": "…signed descriptor…" }
    ]
  }
}
```

Each `token` **is** the descriptor: an opaque, server-signed payload minted at
SSR over `(id, component, props, subscribes, pageUrl)` (§6). The client never
sees or echoes those fields in the clear — it holds an id and a capability. The
server verifies the signature and decodes the descriptor from the token itself;
there is nothing to cross-check and nothing a client could substitute. The
manifest lists only **resumed, refreshable** boundaries currently on the page
(upgraded boundaries need no descriptor — `$cache.set` covers them by key); it
is absent — and the request byte-identical to today — when the resume pack is
absent. `seq` is a per-page monotonic counter stamped by the client (§5.3).

How it gets into the body is a **net-new client seam** (the current stub
hard-codes `body: { args }`): the stub consults
`globalThis.__SIGX_SERVERFN_REFRESH__?: () => RefreshManifest | undefined`
before POSTing — registered by the resume pack, absent otherwise — the
request-side sibling of the existing `__SIGX_SERVERFN_CACHE__` response seam.
Never through `serverFn` itself.

### 2.3 `SSRBoundaryRecord` additions

Three additive fields on `SSRBoundaryRecord`
(`packages/server-renderer/src/boundary.ts`, beside `state`):

```ts
export interface SSRBoundaryRecord {
  // …existing: flush?, hydrate?, media?, props?, state?, chunk?, component?, errorScope?
  /** Canonical cache keys this boundary read during SSR (§3). */
  subscribes?: string[];
  /** Opt-out: non-serializable DI needs — decline single-flight, use $cache. */
  refreshable?: false;
  /** Signed refresh capability minted at SSR (§6); absent ⇒ not single-flightable. */
  token?: string;
}
```

All three serialize into the existing `window.__SIGX_BOUNDARIES__` table
(`emitBoundaryTable`, `packages/server-renderer/src/serialize.ts`) — the same
wire channel `state` already rides, and the same table `boundaryPatchJs`
already knows how to patch mid-stream.

## 3. Capturing subscriptions at SSR (already ~90% built)

The load-bearing claim — "we know which keys a boundary read on the server" —
needs almost no new machinery, because core already records it.

During the SSR walk, `useData(key, fetcher)` on the server routes through the
per-component provider `serverUseAsync`
(`packages/server-renderer/src/server/render-core.ts`), which on a successful
fetch calls `recordComponentKey(ctx, id, key)` — appending the **canonical
string key** (the same identity `@sigx/cache` stores) into
`SSRContext._asyncKeysByComponent: Map<number, string[]>`
(`packages/server-renderer/src/server/context.ts`), a per-request, concurrency-
safe map documented as "which keys each component registered." This is the exact
analogue of how the resume plugin swaps `ctx.signal` for a tracking signal to
capture state.

The resume plugin already writes records at the right moments: its
`afterRenderComponent(id, _vnode, _html, ctx)` and
`onAsyncComponentResolved(id, _html, ctx)` hooks (`packages/resume/src/
plugin.ts`) hold both the boundary `id` and `ctx`, and already write
`record.state = serializeSignalState(signalMap)`. Writing
`record.subscribes` beside it is a one-line mirror:

```ts
// in the resume plugin, next to the existing record.state write:
const keys = collectSubtreeKeys(ctx, id);   // see below
if (keys.length) record.subscribes = keys;
```

`stateSerializationPlugin` (`packages/server-renderer/src/server/state-plugin.ts`)
already reads `ctx._asyncKeysByComponent.get(id)` for streamed per-component
preScripts — precedent that this map is the intended consumption point.

**The one genuinely new bit — subtree aggregation.** Keys are filed under the id
of the component that *called* `useData`. If a boundary reads its own data,
`_asyncKeysByComponent.get(boundaryId)` is exactly right. If a **descendant**
(non-boundary) component inside the boundary subtree reads the key, it is filed
under the descendant's id. To make `subscribes` mean "any key read anywhere in
this boundary's subtree," `collectSubtreeKeys` rolls up descendant ids — and the
mechanism is the **id range**, not the component stack. `ctx._componentStack` is
a live ancestor-path LIFO: every descendant has already pushed *and popped*
itself by the time `afterRenderComponent(boundaryId)` fires, so the stack cannot
yield the subtree. What can: `nextId()` allocates in depth-first pre-order, so a
boundary's descendants occupy the contiguous range `(boundaryId,
lastIdAllocatedWhenTheBoundaryCompletes]` — the same invariant the client
already leans on ("lowest-id `$c:` comment in a contiguous sequence",
`packages/server-renderer/src/client/scheduler.ts`; and the errorScope rewind in
`render-core.ts` reconstructs subtrees the same way). `collectSubtreeKeys`
snapshots the id counter at boundary entry and unions
`_asyncKeysByComponent` over that range at boundary completion. One caveat to
carry into implementation: **deferred/async subtrees can interleave id
allocation across siblings**, so the `onAsyncComponentResolved` path must bound
the range by the boundary's own async completion, not the global counter.

**Decision (this RFC):** capture **subtree-wide** subscriptions. Own-reads-only
is one line cheaper but silently misses the common "boundary wraps a data-reading
child" case, producing a boundary that should refresh and doesn't — a
correctness gap, not a perf one. Subtree aggregation is the correct default.

**Semantics.** `subscribes` = keys the boundary has *successful server data* for.
Errored reads and `{ server: false }` client-only reads are not recorded
(`serverUseAsync` records only on the fetch-success arm), which is exactly right:
a boundary with no server data for a key has nothing the server can refresh.

## 4. Server: surgical single-boundary re-render

The mutation handler must re-render individual boundary components. Three facts
shape the design: (a) `@sigx/server` must not import `@sigx/server-renderer`;
(b) there is today **no server-side component registry** (`record.component`
resolves to a factory only in the browser, via
`packages/server-renderer/src/client/registry.ts`); (c) rendering always starts
from a VNode in a live `SSRContext`, and boundary ids are positional.

### 4.1 The intersection (what to render) — behind the seam, not in the handler

The `invalidates`×`subscribes` intersection must use the cache pack's
`keyMatches(entryKey, pattern)` predicate (`packages/cache/src/store.ts` —
exact string equality or canonical-tuple-prefix), so `$cache` and `$boundaries`
can never disagree about what a key means. But `@sigx/server` has **zero
runtime dependencies** and must stay that way — it cannot import `@sigx/cache`
(and `keyMatches` is not even in cache's public entry today). So the handler
does **not** intersect. After `fn.__sigxFn` resolves it computes `invalidates`
(it already does, for `$cache`) and hands the raw patterns plus the opaque
manifest across the render seam (§4.2); the seam implementation — which lives
renderer-side and is free to depend on `@sigx/cache` — verifies tokens, decodes
descriptors, and intersects with `keyMatches` (exported publicly from
`@sigx/cache` as part of this work; a one-line export of an existing function).
`@sigx/server` stays component-agnostic *and* key-semantics-agnostic.

### 4.2 The re-render (component-agnostic bridge)

`@sigx/server` calls a **process-global server seam** — mirroring the client
`__SIGX_SERVERFN_CACHE__` pattern, on the server side:

```ts
// registered once at mount by a small @sigx/server-renderer (or resume) helper,
// closing over the ssr instance + the per-request app/provide factory:
globalThis.__SIGX_SERVERFN_RENDER__?: (
  manifest: RefreshManifest,                        // opaque tokens, verified inside (§6)
  invalidates: ReadonlyArray<string | readonly unknown[]>,
  request: Request,
) => Promise<{
  patches: Array<{ id: number; html: string; state?: Record<string, unknown> }>;
  set?: Record<string, unknown>;                    // canonical key → fresh value (§2.1)
}>
```

The handler calls it with the raw manifest, the computed `invalidates`
patterns, and the current `Request` (for cookies/auth; the originating page URL
is inside each signed token, §6). The result maps directly onto the envelope:
`patches` becomes `$boundaries.patches`, `set` becomes `$cache.set`. If the
seam is absent (no SSR renderer wired), both are simply omitted —
forward-compatible, like an unknowing v1 client ignoring the field.

The registered implementation verifies each token (§6), decodes the descriptor
it carries, intersects `subscribes` × `invalidates` (§4.1), and then, for each
surviving target:
1. resolves `component` → a factory via a **new server-side registry**
   (`registerServerComponent(key, factory)`), populated by the resume/islands
   Vite transform emitting a server registration mirroring the client's
   `__registerIslandChunk`. This registry is the one substantial new build-side
   piece; it is the server analogue of an artifact that already exists on the
   client.
2. reconstructs `h(factory, props)` from the decoded descriptor,
3. renders it via `renderVNodeToString` in a **fresh `SSRContext` with the resume
   plugin registered** — so the tracking-signal state capture *and* the §3
   subscription capture run exactly as in a full render,
4. reads back `{ html, state }` from the fresh context's boundary table, and
   drains the context's `_asyncResults` (canonical key → resolved value) into
   the shared `set` map — the `$cache.set` payload comes for free from the same
   walk.

Building a fresh app/context per call is concurrency-safe by construction — it is
the same discipline `createRequestHandler`'s `app(url, req)` factory already uses
("a FRESH app per request", `packages/server-renderer/src/node.ts`).

**Alternative considered:** an explicit `refresh` option on the fn-handler mount
instead of a global. Rejected as the default because the two handlers mount as
independent siblings and do not otherwise share config; the global seam keeps the
wiring to a single `enableSingleFlight(ssr, appFactory)` call at boot and matches
the `$cache` precedent. The explicit option remains available for hosts that
prefer no globals; the seam is the documented path.

**Fresh-data coherence.** The re-render runs *after* `fn.__sigxFn` resolved, in
the same request. A `useData(['cart'])` in the re-rendered component therefore
reads whatever the mutation just wrote — a DB row, a store entry, an upstream
fetch. This is the same in-process ordering that makes `invalidates` correct;
single-flight simply renders on the near side of it.

### 4.3 Client owns the id

A fresh isolated render cannot reproduce the original positional boundary id (the
`_componentId` counter restarts at 0). So the **client's** id — the one keying
`window.__SIGX_BOUNDARIES__` and the resume `scopes` map — is authoritative,
carried in the manifest and echoed verbatim in `$boundaries`. The server-local
render id is an implementation detail, discarded.

## 5. Client: patching the boundary

The stub delivers `$boundaries` to a resume-owned client seam
(`globalThis.__SIGX_SERVERFN_BOUNDARIES__`), exactly as it delivers `$cache` to
`__SIGX_SERVERFN_CACHE__` today (`deliverCacheDirectives`,
`packages/server/src/client/index.ts`). The resume consumer, per `{id, html,
state}`, looks up `getScope(id)` (`packages/resume/src/client/scope.ts`) and
branches on `_status`:

- **`resumed`** (never hydrated) → **DOM surgery, no chunk load.** Find the
  `<!--$c:id-->` marker (`findBoundaryMarker`), swap the content root (the
  element immediately before the marker — the invariant `hydration-core.ts` and
  `upgrade.ts` already rely on) for `html`, overwrite the boundary's
  `record.state` in `__SIGX_BOUNDARIES__`, **refresh the scope** (§5.1), and
  `invalidateMarkerIndex()`. The component updated without ever loading its
  chunk — "the server does the thinking, the client patches pixels."
- **`upgrading` or `upgraded`** → **drop the patch.** The boundary upgraded (or
  is upgrading) between manifest and response; its live state wins. It is no
  longer dormant, so it is exactly the case `$cache.set`/`$cache` already
  covers — nothing is lost, only the snapshot is discarded.

Hydrated components never appear in `$boundaries` at all (§1, §2.2): they are
served by the `$cache.set` write, which the *cache* consumer applies —
`__SIGX_SERVERFN_CACHE__` (#311) extended to handle `set` beside `invalidates`:
write each entry's value, stamp it fresh, notify subscribers. Purely additive
to the shipped seam.

### 5.1 Per-id scope refresh (net-new)

Today `resetResumeScopes()` is all-or-nothing. Single-flight needs a per-id
refresh so subsequent handlers on a resumed boundary see the new state:
overwrite `_record` and `_record.state`, reset `_values = { ...newState }`, clear
`_pendingWrites`, keep `_status === 'resumed'`. This is the one new function in
`scope.ts`; everything else reuses existing primitives.

### 5.2 Precedence: `set` beats `invalidates`, surgery beats both

Apply order, all within one response:

1. **`$boundaries.patches`** — DOM surgery on resumed boundaries (§5, above).
2. **`$cache.set`** — fresh values written into the cache; entries stamped
   fresh; live subscribers notified. A key present in `set` is **satisfied**:
   it is skipped by step 3 (fresh data supersedes an invalidation of the same
   key — invalidating it again would trigger a pointless refetch of a value we
   are holding).
3. **`$cache.invalidates`** — the remaining keys (matched via `keyMatches`, less
   the `set` keys) invalidate exactly as #311 shipped. This covers keys the
   server had no value for — e.g. an invalidated key read only by hydrated
   components, where no resumed-boundary re-render captured it.

`$cache` invalidation remains the correct, complete fallback; `set` and
`$boundaries` are fast paths layered over it. A declined boundary
(`refreshable:false`, bad token, nested-boundary exclusion §7) simply never
produces a patch and its keys ride steps 2–3.

### 5.3 Ordering guard — out-of-order responses

Two mutations in flight can resolve out of order; an older `$boundaries` patch
landing after a newer one must not regress pixels. The manifest's `seq` (§2.2)
— a per-page monotonic counter stamped by the client at request time — is
echoed in `$boundaries.seq`. The consumer keeps `lastAppliedSeq` per boundary
id and drops any patch whose `seq` is not greater. Same rule for `$cache.set`:
the cache consumer keeps the seq per key and ignores older writes
(`invalidates` needs no guard — invalidation is idempotent). Zero developer
surface; a few integers of client state.

## 6. Security

The manifest lets a client ask the server to re-render server components and
return their HTML. Same-origin and Origin-checked (every `serverFn` call
already is, `rfc-server.md` §5), and rendering is read-only — but "render a
component of the client's choosing with props of the client's choosing" would
be a new probing surface versus v1, and the server has no per-component prop
validator to lean on. So the design removes the choice entirely.

**Posture — the token *is* the descriptor.** At SSR, for each refreshable
boundary, the server mints a compact signed token (HMAC over a canonical
encoding, keyed by a server secret) whose **payload is the descriptor itself**:
`(id, component, props, subscribes, pageUrl)`. The token rides the existing
boundary table (`SSRBoundaryRecord.token`, §2.3); the manifest sends it back
opaque (§2.2). The server verifies the signature and **decodes** the
descriptor from the token — component, props, keys, and originating page URL
all come from what the server itself signed, never from client-writable
fields. There is no plaintext copy to cross-verify and nothing to desync;
substitution of any field is structurally impossible, not merely checked. A
client holds exactly one capability: "refresh what you rendered for me on this
page, as you rendered it." Invalid or missing tokens are silently dropped —
the boundary rides the `$cache` path (§5.2). This keeps the feature within
`rfc-server.md` §5's defaults and the "the build knows — the runtime doesn't
guess" discipline.

There is deliberately **no unsigned mode**: without a signing secret configured
the SSR side simply mints no tokens, the manifest is empty, and everything
falls back to `$cache` — the feature degrades to #311, it never weakens.
The `enableSingleFlight(...)` helper (§4.2) takes (or generates) the secret;
key rotation invalidates outstanding tokens, which is safe (fallback, not
failure).

## 7. Edge cases and non-goals

- **Structural / list changes.** A mutation that changes a list's item count is
  handled: the re-render is of the *boundary component*, which re-renders its
  whole list subtree; the DOM swap replaces the entire content root. Reconciling
  *within* a resumed subtree (keyed diffing without a component) is out of scope —
  we swap the root, we do not diff.
- **Nested boundaries.** Fresh HTML from an isolated re-render contains
  server-local `$c:` marker ids (the counter restarts, §4.3) — swapping it in
  under a boundary that *contains other boundaries* would orphan or collide
  with live entries in the `scopes` map. v1 therefore mints no token for (and
  never patches) a boundary whose subtree contains another refreshable
  boundary: the **innermost** subscribing boundary is the single-flight target;
  ancestors ride `$cache`. Remapping nested ids inside a patch is future work,
  not v1.
- **Single-root boundaries only.** DOM surgery swaps the nearest element
  preceding the `<!--$c:id-->` marker — the same single-content-root invariant
  hydration and upgrade already rely on (`hydration-core.ts`, `upgrade.ts`).
  A multi-root or text-only-root boundary is not single-flightable (no token
  minted); it falls back to `$cache`, exactly as it already falls outside
  upgrade's swap path today.
- **Streaming / deferred boundaries.** A boundary still `flush:'stream'` (its
  content not yet flushed) is not a single-flight target; it resolves through the
  normal streaming channel. Only settled, recorded boundaries are refreshable.
- **Error boundaries.** A boundary whose SSR render errored (`record.errorScope`)
  is not refreshed by state; a mutation that would fix it is a full remount
  concern (resume's `retry`), not single-flight.
- **SPA-navigated pages.** After a client navigation, `resetResumeScopes()` has
  cleared the scopes; boundaries from the new route are ordinary hydrated
  components subscribed in `CacheStore` — the `$cache.set`/`$cache` paths cover
  them. Single-flight's resumed-boundary fast path applies to the
  server-delivered page, which is where dormant boundaries exist.
- **`serverStream` functions.** Streaming responses (NDJSON, #340) fork before
  the envelope path and carry no `$cache` today; they carry no `$boundaries`
  either. `serverStream` has no `invalidates` option — single-flight is a
  buffered-`serverFn` feature. (If streams ever gain directives, a trailing
  envelope frame is the natural slot — out of scope here.)
- **Non-serializable state → `$cache`.** Covered by `refreshable:false` (§1, §5).
- **No new authoring primitive.** No `refresh()`, no `<Refresh>`, no option on
  `serverFn` or `useAction`. The mechanism is `invalidates` + boundary state, per
  the `no_query_extend_useasync` principle.
- **No RPC machinery in `@sigx/server-renderer` core.** The render seam is
  registered by a mount-time helper and a build-emitted registry; core gains
  three optional record fields (§2.3) and nothing else.

## 8. Observability — making the invisible debuggable

The whole feature is invisible by design: no API is called, pixels just stay
right. That is the DX goal *and* a debugging hazard — "why didn't my badge
update?" has no surface to inspect. Dev builds therefore narrate every decision
(`__DEV__`-guarded, stripped from prod, per the repo convention):

- server: `single-flight: rendered CartBadge#7 (matched ["cart"]) → patch + set`
- server: `single-flight: skipped #9 — invalid token → $cache` (likewise
  `refreshable:false`, nested boundary, no key match)
- client: `single-flight: patched boundary #7 — chunk not loaded`
- client: `single-flight: dropped patch #7 (upgraded mid-flight / stale seq 11 < 12)`
- client: `$cache.set: wrote ["cart"] — 2 subscribers notified`

Phase 4 (§10) also ships a test-utils assertion helper so an app can assert
"this mutation single-flighted that boundary" (vs. silently riding the `$cache`
fallback) in an integration test instead of eyeballing network tabs.

## 9. Compatibility

Purely additive:
- `$boundaries` was reserved in the v1 envelope and is ignored by clients that
  don't know it; adding it breaks nothing.
- `$cache` (#311) keeps its shipped shape and gains one optional field, `set`
  (§2.1); the shipped `invalidates` semantics are unchanged and remain the
  complete fallback (§5.2).
- `serverFn` authoring surface is unchanged — `invalidates` is the #311 API.
- The request manifest is absent (request byte-identical to today) when the
  resume pack is absent, and is additive JSON when present. The
  `__SIGX_SERVERFN_REFRESH__` body seam (§2.2) is net-new but optional-by-
  construction, like every `__SIGX_SERVERFN_*` seam.
- `SSRBoundaryRecord` gains three optional fields on the same wire table.
- No change to `useData`/`useAction`/engine-seam contracts — a server function is
  still a plain async fetcher; a boundary is still a self-describing record.

## 10. Phasing (implementation — not committed by this RFC)

Post-approval, sequenced as independently reviewable PRs under #313, matching the
repo's #340/#358 phased history:

1. **Server registry + surgical render primitive** — `registerServerComponent`,
   the Vite-transform server emission, and a single-boundary render helper over
   `renderVNodeToString` in a fresh resume-plugin context.
2. **SSR subscription capture + tokens + envelope** —
   `SSRBoundaryRecord.subscribes` (id-range subtree aggregation, §3), token
   minting (§6), the `keyMatches` public export from `@sigx/cache`, the
   `__SIGX_SERVERFN_RENDER__` seam (verify → intersect → render), and
   `$boundaries`/`$cache.set` in the envelope. Testable server-side: envelope
   carries fresh html+state+set for intersected boundaries.
3. **Client patching** — the `__SIGX_SERVERFN_REFRESH__` manifest seam, the
   `__SIGX_SERVERFN_BOUNDARIES__` consumer (resumed-patch / drop branches),
   per-id scope refresh, marker/DOM-swap, `$cache.set` handling in the cache
   consumer, and the §5.3 seq guard.
4. **Decline + fallback + example** — `refreshable:false` authoring surface,
   §5.2 precedence, dev-mode narration + test-utils helper (§8), the storefront
   example wiring, docs (`packages/server/README.md`,
   `packages/resume/README.md`, and a docs-site issue).

## Open questions

- **`refreshable:false` spelling (§1).** The record field is the contract; the
  island-site attribute sugar (candidate: `refresh={false}` beside `client:*`)
  is decided by the phase-4 PR.
- **Seam vs. explicit mount option (§4.2).** RFC recommends the global seam for
  the default; the explicit option stays documented for globals-averse hosts.
- **`$cache.set` for absent entries.** Writing a `set` value for a key the
  client cache has never seen creates a warm entry (harmless prefill) — or
  could be skipped. Default: write it; revisit if memory pressure ever says
  otherwise.
- **Future optimization (non-committed).** The Vite transform could lift
  statically-analyzable `invalidates` literals into the client stub so the
  manifest sends only plausibly-matching tokens on island-heavy pages. Pure
  bandwidth optimization; semantics unchanged; not v1.
