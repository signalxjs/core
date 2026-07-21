# Changelog

All notable changes to `@sigx/server-renderer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
