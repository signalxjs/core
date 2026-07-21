# Changelog

All notable changes to `@sigx/server-renderer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

**Fixed: an indented mount container no longer defeats hydration.**

- `hydrate()` passes `container.firstChild` to the walk verbatim, and the
  walk's skip loop advances past comments only. So when the host page
  pretty-prints its mount container — `<div id="app">\n  <div …>` — a
  component's SSR range began at a whitespace text node, which the
  structural-mismatch check (#115) treated as a mismatch. The hydrator then
  discarded the entire server-rendered subtree and re-rendered it on the
  client: hydration defeated by indentation alone, and on a root component
  that meant the whole page.
- Whitespace-only leading text is now skipped instead. Text with **visible**
  content still bails — that is the real #115 orphan case, where hydration
  would otherwise abandon SSR text as content no VNode owns. The change
  strictly narrows the bail set; nothing that hydrated before starts bailing.
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
