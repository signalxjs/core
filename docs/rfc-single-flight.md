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
  refetch (resumed, never-hydrated boundaries). No new developer surface.
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
keys each live boundary captured at SSR, select the boundaries the server
surgically re-renders and piggybacks back as `$boundaries: [{id, html, state}]`;
the resume runtime patches resumed boundaries by DOM surgery (chunk never loads)
and upgraded boundaries by live-signal write.

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
| **upgraded** (hydrated) | yes | fresh `state` written through live signals (fine-grained patch, **no refetch**) |
| **not refreshable** (`refreshable:false`) | yes | excluded from single-flight → falls back to `$cache` invalidation (#311) |
| any | no | untouched |

The one opt-out is `refreshable: false` (§5), for boundaries whose correctness
depends on non-serializable, request-scoped DI the server cannot reconstruct in
isolation. Those decline and ride the existing `$cache` path. It is an opt-out,
not an opt-in — refresh is the default consequence of a correct `invalidates`.

## 2. Wire contract

### 2.1 Response envelope — the reserved `$boundaries`

The success envelope (built in `handleServerFnRequest`,
`packages/server/src/server/index.ts`) gains `$boundaries` beside the existing
`data`/`$cache`:

```jsonc
200 {
  "data": { /* mutation result */ },
  "$cache": { "invalidates": [["cart"]] },          // #311, unchanged
  "$boundaries": [
    { "id": 7, "html": "<span>3</span>", "state": { "count": 3 } }
  ]
}
```

`id` is the **client's** boundary id, carried round-trip (§4.3) — the client
patches DOM by it. `html` is the freshly rendered content root. `state` is the
freshly captured signal-state snapshot (the same `serializeSignalState` output
that becomes `SSRBoundaryRecord.state`). An upgraded-only refresh may omit
`html` (state suffices; §4.2).

### 2.2 Request manifest — how the server learns the live boundaries

`serverFn` cannot name boundaries, and the server holds no session across the
document GET and the mutation POST — so the **client** supplies the live
boundary descriptors, in the request body beside `args`, contributed by the
resume/cache packs through a client seam (never through `serverFn`):

```jsonc
POST /_sigx/fn/addToCart_fn_9f3a01cc
{
  "args": [{ "id": "sku-42" }],
  "$refresh": [
    { "id": 7, "component": "CartBadge#a1b2c3", "props": {},
      "subscribes": ["[\"cart\"]"], "token": "…hmac…" }
  ]
}
```

Each descriptor is a projection of the boundary's `SSRBoundaryRecord`
(`component`, `props`) plus its SSR-captured `subscribes` keys (§3) and a signed
token (§6). The manifest includes only **refreshable** boundaries currently on
the page (resumed and upgraded); it is empty — and the request byte-identical to
today — when the resume pack is absent. The server never trusts it blindly (§6).

### 2.3 `SSRBoundaryRecord` additions

Two additive fields on `SSRBoundaryRecord`
(`packages/server-renderer/src/boundary.ts`, beside `state`):

```ts
export interface SSRBoundaryRecord {
  // …existing: flush?, hydrate?, media?, props?, state?, chunk?, component?, errorScope?
  /** Canonical cache keys this boundary read during SSR (§3). */
  subscribes?: string[];
  /** Opt-out: non-serializable DI needs — decline single-flight, use $cache. */
  refreshable?: false;
}
```

Both serialize into the existing `window.__SIGX_BOUNDARIES__` table
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
this boundary's subtree," `collectSubtreeKeys` rolls up the descendant ids
rendered under the boundary — derivable from the walk's push/pop component stack
(`ctx._componentStack`), which brackets each boundary's subtree as a contiguous
id range.

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

### 4.1 The intersection (what to render)

After `fn.__sigxFn` resolves, the handler computes `invalidates` (it already
does, for `$cache`), then intersects those patterns against each manifest
descriptor's `subscribes` keys using the cache pack's **existing**
`keyMatches(entryKey, pattern)` predicate (`packages/cache/src/store.ts` —
exact string equality or canonical-tuple-prefix). A descriptor whose keys match
any invalidated pattern is a refresh target. This reuses the *identical*
comparison `store.invalidate` uses, so `$cache` and `$boundaries` can never
disagree about what a key means.

### 4.2 The re-render (component-agnostic bridge)

`@sigx/server` calls a **process-global server seam** — mirroring the client
`__SIGX_SERVERFN_CACHE__` pattern, on the server side:

```ts
// registered once at mount by a small @sigx/server-renderer (or resume) helper,
// closing over the ssr instance + the per-request app/provide factory:
globalThis.__SIGX_SERVERFN_RENDER__?: (
  targets: BoundaryDescriptor[],
  request: Request,
) => Promise<Array<{ id: number; html: string; state?: Record<string, unknown> }>>
```

The handler calls it with the intersected targets and the current `Request`
(for cookies/auth and the originating page URL, sent in the manifest). If the
seam is absent (no SSR renderer wired), `$boundaries` is simply omitted —
forward-compatible, like an unknowing v1 client ignoring the field.

The registered implementation, for each target:
1. resolves `component` → a factory via a **new server-side registry**
   (`registerServerComponent(key, factory)`), populated by the resume/islands
   Vite transform emitting a server registration mirroring the client's
   `__registerIslandChunk`. This registry is the one substantial new build-side
   piece; it is the server analogue of an artifact that already exists on the
   client.
2. reconstructs `h(factory, props)` from the descriptor,
3. renders it via `renderVNodeToString` in a **fresh `SSRContext` with the resume
   plugin registered** — so the tracking-signal state capture *and* the §3
   subscription capture run exactly as in a full render,
4. reads back `{ html, state }` from the fresh context's boundary table.

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
- **`upgraded`** (hydrated) → **live-signal write.** Skip `html`; write each
  `state[name]` through `scope._live[name].value`, the exact replay path
  `runUpgrade` already uses (`upgrade.ts`). Fine-grained reactivity patches the
  DOM; no refetch, no diff.
- **`upgrading`** (in flight) → **drop.** A refresh landing mid-upgrade is
  discarded; the upgrade's live state wins (it reflects a user interaction in
  progress, which must not be clobbered by a slightly-stale server snapshot).

### 5.1 Per-id scope refresh (net-new)

Today `resetResumeScopes()` is all-or-nothing. Single-flight needs a per-id
refresh so subsequent handlers on a resumed boundary see the new state:
overwrite `_record` and `_record.state`, reset `_values = { ...newState }`, clear
`_pendingWrites`, keep `_status === 'resumed'`. This is the one new function in
`scope.ts`; everything else reuses existing primitives.

### 5.2 `$cache` ↔ `$boundaries` precedence

A boundary refreshed via `$boundaries` must **not** also refetch via `$cache`.
Precedence: **single-flight wins.** The client applies `$boundaries` first and
records which boundary ids (and thereby which keys, via each record's
`subscribes`) it satisfied; the `$cache` consumer then invalidates only keys not
fully covered by a single-flight patch. A key whose every live subscriber was
single-flighted is not re-invalidated — no double work. Keys with hydrated
subscribers the server chose not to render (or could not) still invalidate
normally. `$cache` remains the correct, complete fallback; `$boundaries` is the
fast path layered over it.

## 6. Security

The manifest lets a client ask the server to render a named component with
client-supplied props and return its HTML. Same-origin and Origin-checked (every
`serverFn` call already is, `rfc-server.md` §5), and rendering is read-only — but
**arbitrary props on an arbitrary registered component** is a new probing surface
versus v1, and the server has no per-component prop validator to lean on.

**Recommended posture — signed boundary descriptors.** At SSR, each emitted
`SSRBoundaryRecord` is accompanied by an HMAC token over `(id, component, props,
subscribes)` keyed by a server secret. The manifest echoes the token; the server
verifies it and renders using the **signed** `component`/`props`, never
client-substituted ones. A client can then only ask to refresh boundaries the
server actually rendered for *this* page, with the props it rendered — exactly
the capability single-flight needs and nothing more. Unsigned/mismatched
descriptors are ignored (the boundary silently falls back to `$cache`). This
mirrors the "the build knows — the runtime doesn't guess" discipline and keeps
the feature within `rfc-server.md` §5's defaults. The token is small and rides
the existing boundary table.

The weaker posture (accept same-origin, unsigned) is documented but not the
default: it trades the probing-surface guarantee for one fewer secret to manage,
and single-flight is precisely the kind of write-adjacent path where the strong
default belongs.

## 7. Edge cases and non-goals

- **Structural / list changes.** A mutation that changes a list's item count is
  handled: the re-render is of the *boundary component*, which re-renders its
  whole list subtree; the DOM swap replaces the entire content root. Reconciling
  *within* a resumed subtree (keyed diffing without a component) is out of scope —
  we swap the root, we do not diff.
- **Streaming / deferred boundaries.** A boundary still `flush:'stream'` (its
  content not yet flushed) is not a single-flight target; it resolves through the
  normal streaming channel. Only settled, recorded boundaries are refreshable.
- **Error boundaries.** A boundary whose SSR render errored (`record.errorScope`)
  is not refreshed by state; a mutation that would fix it is a full remount
  concern (resume's `retry`), not single-flight.
- **SPA-navigated pages.** After a client navigation, `resetResumeScopes()` has
  cleared the scopes; boundaries from the new route are ordinary hydrated
  components subscribed in `CacheStore` — the `upgraded`/`$cache` paths cover
  them. Single-flight's resumed-boundary fast path applies to the
  server-delivered page, which is where dormant boundaries exist.
- **Non-serializable state → `$cache`.** Covered by `refreshable:false` (§1, §5).
- **No new authoring primitive.** No `refresh()`, no `<Refresh>`, no option on
  `serverFn` or `useAction`. The mechanism is `invalidates` + boundary state, per
  the `no_query_extend_useasync` principle.
- **No RPC machinery in `@sigx/server-renderer` core.** The render seam is
  registered by a mount-time helper and a build-emitted registry; core gains a
  `subscribes` field and nothing else.

## 8. Compatibility

Purely additive:
- `$boundaries` was reserved in the v1 envelope and is ignored by clients that
  don't know it; adding it breaks nothing.
- `$cache` (#311) is unchanged; §5.2 layers over it.
- `serverFn` authoring surface is unchanged — `invalidates` is the #311 API.
- The request manifest is empty (request byte-identical to today) when the resume
  pack is absent, and is additive JSON when present.
- `SSRBoundaryRecord` gains two optional fields on the same wire table.
- No change to `useData`/`useAction`/engine-seam contracts — a server function is
  still a plain async fetcher; a boundary is still a self-describing record.

## 9. Phasing (implementation — not committed by this RFC)

Post-approval, sequenced as independently reviewable PRs under #313, matching the
repo's #340/#358 phased history:

1. **Server registry + surgical render primitive** — `registerServerComponent`,
   the Vite-transform server emission, and a single-boundary render helper over
   `renderVNodeToString` in a fresh resume-plugin context.
2. **SSR subscription capture + envelope** — `SSRBoundaryRecord.subscribes`
   (subtree aggregation), the `invalidates`×`subscribes` intersection, the
   `__SIGX_SERVERFN_RENDER__` seam, and `$boundaries` in the envelope. Testable
   server-side: envelope carries fresh html+state for intersected boundaries.
3. **Client resume patching** — the `__SIGX_SERVERFN_BOUNDARIES__` consumer, the
   three `_status` branches, per-id scope refresh, marker/DOM-swap.
4. **Decline + fallback + example** — `refreshable:false`, `$cache`↔`$boundaries`
   precedence, signed descriptors (§6), the storefront example wiring, docs
   (`packages/server/README.md`, `packages/resume/README.md`, and a docs-site
   issue).

## Open questions

- **Signed vs. same-origin descriptors (§6).** RFC recommends signed; final call
  is Andreas's, weighing secret management against the probing-surface guarantee.
- **Seam vs. explicit mount option (§4.2).** RFC recommends the global seam for
  the default; the explicit option stays documented for globals-averse hosts.
- **Upgraded-boundary HTML.** §4.2/§5 omit `html` for upgraded targets (state
  suffices). If a future non-signal-backed upgraded boundary needs HTML, the
  envelope already allows it — no wire change, a client-branch addition.
