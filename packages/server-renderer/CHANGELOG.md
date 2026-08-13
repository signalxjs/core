# Changelog

All notable changes to `@sigx/server-renderer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.15.4] - 2026-08-13

### Fixed

- **Hydration binds the trailing anchor for every Fragment (#658).** The
  hydration walk traversed fragments transparently and left `vnode.dom`
  unset, so the first append into a hydrated fragment fell back to a null
  insertion anchor and the new node landed *past* the fragment's trailing
  siblings. With #658 giving every array child a stable Fragment shape, that
  gap would have covered every hydrated list; it already existed for 2+-item
  arrays. `hydrateNode` now synthesizes the same trailing anchor comment a
  client mount creates. Hydrated DOM therefore contains one `<!---->` per
  fragment — converging with what a client-side mount of the same tree
  produces, rather than diverging from it.

## [0.15.3] - 2026-08-07

### Changed

- **The document-complete script has one emitter (#634).**
  `window.__SIGX_STREAMING_COMPLETE__=true;window.dispatchEvent(new Event('sigx:ready'));`
  was three byte-identical copies across `document.ts` and both streaming paths
  in `ssr.ts` — a drift hazard on a string that `scripts/deploy-smoke` and
  `scripts/edge-smoke.mjs` assert verbatim. It is now `completionScript(nonce)`
  in `server/serialize.ts`, beside `scriptOpen`. **Output is unchanged.** The
  global itself stays enumerable: it is written by the emitted script and is an
  app-facing contract (nothing in this repo reads it — the `sigx:ready` event
  is the half most apps should use). See `docs/seams.md`.

## [0.15.0] - 2026-08-04

**Added: streamed responses extend the server-function scope to end-of-body (#571).**

- `createFetchHandler`'s streaming return now registers a `keepAlive(until)`
  on the `__SIGX_SERVERFN_SCOPE__` seam — feature-detected, so an older
  `@sigx/server` without it stays a supported no-op — with a promise
  `chunksToBytes` resolves on whichever ending the body reaches (close,
  error, client cancel; the encoder gained an optional `onSettled`
  callback). With a `keepAlive`-capable `@sigx/server`, request-value
  disposal (`perRequest` `onDispose`) fires when the response has FULLY
  FLUSHED instead of at the shell — the rfc-server-v3 §2.6 constraint that
  deferred disposal from v1. The redirect and shell-error branches register
  nothing (run-settle disposal is correct where there is no body), and the
  Node handler needs no change (it awaits body end inside the scope).

**Changed: `slot=` on a COMPONENT child no longer routes it into a named slot (#588).**

- Mirrors the client-side change (root `CHANGELOG.md`): the server's slot
  extractor shared the client's accidental duck-check — any object vnode with
  `props.slot` routed, so a component child reached a named slot despite the
  JSX types rejecting it. Such a child now renders in the default slot with a
  `__DEV__` warning, identically on both sides: the predicate is one shared
  helper (`namedSlotFor` from `sigx/internals`), so server and client cannot
  disagree on slot presence and hydration cannot mismatch over it. Host
  element children with `slot=` are unaffected.

**Fixed: only the component a streamed placeholder belongs to may hydrate inside it (#492).**

- Follow-up to #478 below, found by reproducing that report's shape against
  **real streamed output** instead of hand-built DOM. The wrapper is the
  content start of every pass-through ancestor as well (`App → RouterView →
  lazy() → Page` — what every router app looks like), and the outermost one
  was descending into it. Two consequences, both live after #478:
  - Ancestors' own `<!--$c:N-->` markers sit OUTSIDE the wrapper, so their
    marker scan ran over the streamed subtree's children instead and latched a
    **descendant's** marker as the component anchor. Not a crash — a component
    whose DOM reference points into the middle of its own subtree, so unmount
    and `patch()`'s replace branch derive the wrong range. #478's synthesized
    anchor never fired here, because a wrong marker is not a missing one.
  - Anything the ancestor rendered **after** the streamed child was hydrated
    against the wrapper's contents and **mounted a second copy inside it** —
    visible duplicated content, and the next route re-parented into a
    placeholder that survives unmount by design (`display: contents` hides it
    from layout, not from `#app > div` selectors).
- Ownership is decidable from what the server already emits: the wrapper is
  named after the streamed component's own marker id (`data-async-placeholder="N"`
  ↔ `<!--$c:N-->`). Only the component whose anchor is that id descends; the
  pass-through ancestors keep their own reachable sibling markers, exactly as
  they would if nothing had streamed. An unreachable anchor (null) still
  descends — that is #478's synthesis case, and it stays.
- A streamed boundary whose region left the document during the streaming
  window is no longer revived: `hydrateAsyncBoundary` returns when the
  placeholder is not connected, instead of running setup and creating a render
  effect for a detached subtree that nothing would ever unmount.
- Coverage: the #478 regression cases hand-built their DOM with streamed
  content containing no nested markers, which is what let this through. The
  new cases go through `createSSR().renderStream()` and replay the stream as a
  browser would. `examples/spa-ssr` gains a `/router-stream` route with that
  shape, and `pnpm smoke:hydration` now drives it through a full navigation
  round trip — three of its assertions fail without this fix while the existing
  marker-survival oracle stays green, which is precisely the blind spot: a
  component with a wrong `dom` still produces a perfect first paint.

**Fixed: a streamed `$SIGX_REPLACE` region hydrates with a real trailing anchor, so the next patch can't crash (#478).**

- A hydrated component vnode could be left with **no DOM reference at all**,
  and the next reactive patch touching it — a client-side navigation, a cell
  state change — died on `TypeError: Cannot read properties of null (reading
  'parentNode')`, wedging the app. The region itself hydrated with no visible
  error, so the crash surfaced later and elsewhere.
- Root of it: the server closes the `<div data-async-placeholder>` wrapper and
  only THEN emits the component's trailing `<!--$c:N-->` marker, so a component
  hydrating *inside* that wrapper can never claim it. `hydrateComponent` used to
  fall back to `endDom` — the first node AFTER its content, which belongs to a
  sibling — or to null. It now **synthesizes a trailing anchor comment** at the
  end of the component's range when no marker is reachable, exactly as
  `mountComponent` always allocates one; every hydrated component vnode is
  patchable again. A page whose markers are reachable is byte-identical: nothing
  is synthesized.
- `hydrateAsyncBoundary` also hydrated the wrapper's *children* with the
  placeholder as the parent and no marker, which defeated the wrapper handling
  the walk-driven path uses. It now hands `hydrateComponent` the placeholder
  itself plus the component's real marker (matched by exact id among the
  placeholder's following siblings).
- And the walk-skipped vnode is no longer abandoned: when the root walk skips a
  streamed placeholder it hands the **live vnode** (with its parent and marker)
  to the `sigx:async-ready` flow through an expando on the placeholder, so the
  vnode the parent tree holds is the one that gets `_effect`/`_subTree` —
  previously an orphan copy was hydrated instead and the parent kept a ghost
  forever, which mounted a duplicate on a same-type patch and crashed on a
  different-type one.
- Behaviour note: a streamed boundary component's `ctx.el` (and its mount hook's
  `ctx.el`) is now the placeholder's **parent** rather than the placeholder,
  matching what the same component sees when it is not streamed.
- Two residues, unchanged and deliberate: the empty
  `<div data-async-placeholder style="display:contents">` survives an unmount
  (the wrapper is not part of the vnode tree, and its `data-hydrated` flag is
  the dedupe guard the leftover scan and `hydrateTableBoundary` rely on), and a
  boundary marked `hydrate: 'never'` stays a ghost by design — a parent patch
  over it now recovers with a fresh mount instead of throwing.

**Added: automatic boundary dep capture (`SSRBoundaryRecord.deps`, rfc-server §6.3, #452).**

- `serverUseAsync` records every canonical `useData` key on the NEAREST
  enclosing boundary record, walking the setup-context parent chain (so
  attribution stays correct across streamed/deferred subtrees, where the
  component stack has already popped) and marking the record unflushed so
  a post-shell read re-ships it mid-stream. Nested boundaries keep their
  own deps; `server:false` and falsy-key reads are deliberately
  unrecorded (nothing of them is baked into the HTML). These deps are the
  single-flight boundary-refresh admission input: the mutation endpoint
  intersects them with the mutation's `invalidates` patterns.

**BREAKING — `__registerIslandChunk` is now `registerComponentChunk` (#439).**

- The lazy chunk-registration entry (`./client`, `./client/scheduler`) was
  renamed: the underscore island name misdescribed a strategy-neutral
  registry — the islands AND resume Vite transforms both emit calls to it.
  Hard rename, no alias (pre-1.0). Generated registry modules are re-emitted
  by the transforms automatically; update hand-written calls.

**Added: the typed pack contract — no more underscore reads for strategy packs (#416).**

- `SSRContext.currentComponentId()` — the id of the component currently
  rendering (top of the component stack, `undefined` outside a component).
  The attribution primitive `resolveBoundary` / `transformComponentContext`
  implementations previously got by reading the private `_componentStack`.
- `SSRContext.boundaries()` — the per-request boundary table as a live
  `ReadonlyMap<number, SSRBoundaryRecord>`, for whole-table scans (islands'
  preload check, resume's refresh envelope). Record mutation stays on
  `getBoundary(id)`; table shape stays core's.
- `SSRContextOptions.appContext` — seed a self-created context with an
  app's DI (type handlers, provides) at creation, replacing the private
  `_appContext` write a boundary refresh needed.
- `SSRPack` (type) — the factory return shape for packs installed with
  `app.use(pack)`: `SSRPlugin` + `install(app)`. Typing the factory's
  object as `SSRPack` and closing over it removes the
  `this as unknown as SSRPlugin` cast packs needed.
- `reviveFromServer` is re-exported from `./client` — the public home for
  the boundary codec's revive half in pack client code (the
  `sigx/internals` re-export is not a contract).
- The `_componentStack` / `_boundaries` / `_appContext` fields are now
  marked `@internal`, each pointing at its public accessor.

**Fixed: the `__SIGX_ASYNC__` blob's admission check is codec-aware (#420).**

- The blob admitted values via a plain `JSON.stringify` test, blind to the
  boundary codec: a top-level `bigint` was dropped with a dev warning, and a
  handler-owned value NESTED in a snapshot (a `bigint` in a `toJSON` result,
  a `Map` in a plain object) rejected the whole key — even though the
  emitter tags all of those and the client revives them. Admission now goes
  through `admitPayloadEntry` — the same check boundary props and state
  signals use — whose fallback round trip runs `stringifyWithHandlers`
  (registered handlers AND built-ins, at every depth) instead of plain JSON.
  The nested-value fix applies to boundary props and state signals too.
  Functions, circular structures, and dangerous keys are still rejected with
  the same warnings. One behavioral edge inherited from the boundary paths:
  a useAsync value of explicit `undefined` is now admitted (tagged `$undef`)
  instead of warned-and-refetched.

**Added: a public write path into the `__SIGX_ASYNC__` blob (#407).**

- `SSRContext.registerSerializedState(key, value)` — the supported way for
  packs that own request-scoped state (`@sigx/store`'s `ssrState` is the
  canonical case) to enter the hydration blob, replacing duck-typed writes to
  the private `_asyncResults` map. A `{ toJSON }` value is encoded at EMIT
  time, so state mutated during the request serializes with its final values
  (`toJSON` may run more than once per flush — keep it pure). Keys share the
  useAsync/useStream namespace (prefix yours: `store:cart`); re-registering an
  already-emitted key ships a patch (the client merge is last-write-wins);
  overwriting a not-yet-flushed value dev-warns.
- `SSRHelper._ctx` is now typed (`SSRContext`, present only during a server
  render) — the per-request access point packs were already duck-typing
  (`useResponse` and `useHead` read through it).
- `onStreamEnd?(ctx)` server plugin hook — called exactly once after the
  streaming race loop drains (and at the end of blocking renders after plugin
  generators), before the completion script: the request's LAST emission
  point. The state plugin uses it as a final drain, so a registration made
  from a chunk generator that finishes last still reaches the client.

**Fixed: state registered during the stream phase was silently dropped (#407).**

- The state plugin's streamed emission looked up per-component keys that only
  useAsync/useStream recorded, so anything else landing in the results map
  during a deferred render never reached the client — a store first created
  below a streamed boundary hydrated from defaults with no warning. Also
  caught by the same early-return: a keyed `useData` inside `<Defer>` under
  streaming recorded its key under the CHILD's component id while the
  resolution hook fired with the Defer's, so the key never shipped and the
  client silently refetched. Emission now drains a request-level dirty-set
  (`_unflushedAsyncKeys`, the #279 boundary-table discipline —
  `_asyncKeysByComponent` is removed), so every registration ships with the
  next flush regardless of which component was resolving.

**Changed (BREAKING): `app.use(...)` is the one pack-install shape (#413).**

- `SSRInstance.use()` is removed. Instance-level plugins move to
  `createSSR({ plugins })` — an advanced/engine channel (the default state
  plugin, tests, custom engines); the public install path is
  `app.use(pack())` on the rendered App.
- New app-carried plugin seam: `provideSSRPlugin(appContext, plugin)` /
  `getSSRPlugins(appContext)` / `SSR_PLUGINS_TOKEN` (root, `/client`, and
  `/server` entries). A pack's `install(app)` registers its server render
  hooks through it; every render path that receives the App merges
  app-carried plugins after instance plugins, deduped by `name` (first wins,
  dev-warned). App-carried order is `app.use()` order, so pack consult order
  stays an app decision.
- `plugin.server.setup(ctx)` now always runs AFTER `ctx._appContext` is
  assigned — setup hooks can resolve app-level provides on every render
  path (previously only the document path got this right).
- `mergeSSRPlugins` / `initPluginContext` exported from `/server` for packs
  that build their own render contexts (e.g. `@sigx/resume`'s boundary
  refresh).
- The document engine's default `stateSerializationPlugin` now also yields
  to an app-carried plugin named `sigx:state`.

**Added: the single-flight boundary-refresh mechanism (rfc-server §6.3, #313).**

- `SSRContextOptions.baseComponentId` — seed the component-id counter so a
  boundary re-render's `<!--$c:N-->` markers and `data-sigx-b` ids never
  collide with ids already live on the page it patches into.
- `SSRBoundaryRecord.refreshable?: false` — stamped at initial SSR when a
  re-render from the serialized snapshot could not reproduce the boundary's
  HTML; the refresh path declines these.
- `installBoundaryRecords(patch)` / `removeBoundaryRecord(id)` on the client
  scheduler — the write half of the table accessor pair: a refresh envelope's
  `records` patch enters `__SIGX_BOUNDARIES__` exactly as a streamed
  assignment would (same null-prototype discipline), and a swapped-out
  boundary's id is retired.

**Added: document renders open the server-function request scope.**

- `createRequestHandler` and `createFetchHandler` now run the whole render —
  streaming included, since `useData` fetchers settle while chunks are pumped —
  inside the request's ambient scope when one can be opened, so a server
  function called in-process during SSR reads the real request (rfc-server §7
  v1.1, #309).
- Read through the `__SIGX_SERVERFN_SCOPE__` seam (docs/seams.md), never an
  import: `@sigx/server` stays an optional pack, an app without server
  functions pays nothing, and with no scope registered the handlers behave
  exactly as before — per-request `SSRContext` remains the isolation mechanism
  and **AsyncLocalStorage is still never required** (rfc-ssr-platform §2.3).

**Fixed: a component followed by sibling content no longer latches its child's
anchor.** (#373)

- SSR emits a TRAILING `<!--$c:N-->` marker per component, so a parent's marker
  comes after its children's. A component that is not handed its marker had to
  find it, and the rule was a guess: lowest id in a *contiguous* comment run,
  breaking at the first non-comment node after any marker. Ordinary sibling
  content ended the run early — for `<div>A</div><!--$c:2--><span>B</span><!--$c:1-->`
  the outer component latched `$c:2`, its **child's** marker.
- Everything downstream is derived from that anchor, so a short one meant: the
  structural-mismatch check (#115) judged the match on a prefix of the range;
  a bail deleted only that prefix and mounted the fresh subtree *before* the
  child's marker, leaving the rest of the SSR content as a duplicated orphan —
  the very symptom the bail exists to prevent; the walk resumed mid-range; and
  the boundary-table lookup used the wrong component id, silently ignoring that
  boundary's hydration strategy.
- The search is now bounded by the enclosing component's marker, and takes the
  lowest id in that range. Component ids come from a pre-order counter entered
  before a component renders its children, so within that bound every other
  marker belongs to a descendant or a later sibling — all with higher ids. The
  pick is exact rather than heuristic, and the wire format is unchanged.
- `hydrateNode`, `hydrateComponent`, `findComponentBoundaries`,
  `scheduleWalkedBoundary` and the `client.hydrateComponent` plugin hook each
  take that bound as a new **optional trailing parameter** (`regionEnd`);
  existing callers and packs compile and behave as before. A pack that locates
  a component's own marker itself should thread it through — the defect applies
  equally to a strategy pack's boundaries.

**Fixed: an indented mount container no longer defeats hydration.**

- `hydrate()` passes `container.firstChild` to the walk verbatim, and the
  walk's skip loop advances past comments only. So when the host page
  pretty-prints its mount container — `<div id="app">\n  <div …>` — a
  component's SSR range began at a whitespace text node, which the
  structural-mismatch check (#115) treated as a mismatch. The hydrator then
  discarded the entire server-rendered subtree and re-rendered it on the
  client: hydration defeated by indentation alone, and on a root component
  that meant the whole page.
- Leading **formatting whitespace** is now skipped instead. Text with visible
  content still bails — that is the real #115 orphan case, where hydration
  would otherwise abandon SSR text as content no VNode owns. The change
  strictly narrows the bail set; nothing that hydrated before starts bailing.
- "Formatting whitespace" means HTML's ASCII whitespace (space, tab, LF, FF,
  CR) — deliberately *not* JavaScript's `\s`, which also matches NBSP and the
  other Unicode space separators. Those are visible characters: a
  server-rendered `&nbsp;` is real content and still triggers the bail.
- The dev-only `Skipped non-matching sibling(s)` warning is now gated on
  having skipped real content, so it no longer fires for every element on a
  formatted page.

**`createFetchHandler` — the WinterCG request handler.** (rfc-deploy §2,
Phase 1 of #321; #323)

- New `createFetchHandler(options): (request, platform?) => Promise<Response>`
  on `@sigx/server-renderer/server` (re-exported from the root entry): the
  fetch-shaped sibling of `createRequestHandler`, with byte-for-byte the
  same dispatch — parallel template/app resolution, bot → blocking mode,
  the shell as the status/redirect decision point, redirects as bodyless
  responses with the generator released, shell failures as a minimal 500.
  The `platform` argument (Cloudflare's `{ env, ctx }`, …) is opaque and
  threaded verbatim into every callback — optional under the default
  `TPlatform = unknown`, required once the generic is instantiated with
  bindings that don't admit `undefined` (omitting it is a compile error,
  keeping the callbacks' `platform: TPlatform` sound).
- New `defaultIsBot` export: the crawler-UA regex behind the bot →
  blocking dispatch, now shared by the fetch, Node, and dev handlers.
- New `chunksToBytes(chunks): ReadableStream<Uint8Array>` export: the
  pull-based string→UTF-8 encoder (backpressure in `pull()`, generator
  released on `cancel()`) extracted from `renderDocumentToWebStream` and
  shared with the fetch handler and hand-written servers.
- The edge smoke (`pnpm test:edge`) now round-trips a full
  `Request → createFetchHandler → Response` through the production dist,
  and covers `@sigx/server`'s `handleServerFnRequest` under the same
  no-Node-builtin import hooks (rfc-deploy §6).

**The boundary scheduler split from the hydration executor — deferred pages
now execute zero runtime JS at load.** (#293)

- New `@sigx/server-renderer/client/scheduler` entry: the eager half of
  selective hydration (strategy scheduling, boundary-table access, marker
  index, the `sigx:async-ready` listener). It value-imports nothing from the
  sigx family — a page whose boundaries are all `idle`/`visible`/`media`/
  `interaction` pays ~2 kB at load instead of executing the renderer. The
  executor (`hydrateComponent`, `render`, in-place/skip-mount) lives in a
  separate dist chunk loaded by `loadHydrationCore()` on the first strategy
  that fires (cached; a failed load retries on the next trigger). The
  `./client` barrel re-exports everything unchanged.
- `registerClientPlugin` now also accepts a **lazy plugin source**
  `{ name, load }` — the plugin module is imported together with the
  hydration core, so a pack's client hooks can live in the same
  lazily-fetched chunk as the renderer. Registrations dedupe by `name`
  (first-wins). New `resolveClientPlugins()` / `hasPendingClientPlugins()`
  accompany it; boundary-scheduled hydration paths resolve lazy sources
  before the first `hydrateComponent`, so synchronous client hooks always
  see resolved plugins.
- New optional server plugin hook `assets(ctx)`: contribute
  `{ modulepreload }` URLs to the document shell, deduped against caller
  assets and core's per-boundary chunk preloads. This is the pack-owned side
  of the preload policy — a pack whose runtime loads lazily keeps the fetch
  off the critical path without core knowing what the chunk is.
- Behavior note: a `hydrate: 'load'` boundary now hydrates after one
  dynamic-import round trip (pair with an `assets()` preload to keep the
  chunk warm) instead of within the entry module's microtask queue.
