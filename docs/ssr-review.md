# Server-renderer review & roadmap (June 2026)

A full review of `@sigx/server-renderer` (v0.4.9) against the bar of a modern,
performant SSR engine, plus the roadmap implemented on the `ssr-next`
integration branch. Tracking issue: signalxjs/core#61.

## Architecture overview (as reviewed)

The engine is in better shape than most v0.x SSR layers:

- **Rendering core** (`src/server/render-core.ts`): a recursive
  `AsyncGenerator<string>` walk (`renderToChunks`) over the vnode tree —
  text/fragment/comment/host-element/component — with HTML escaping, style
  object serialization, void-element handling, directive `getSSRProps`
  support, and component boundary markers (`<!--$c:ID-->`) plus text-merge
  guards (`<!--t-->`). A duplicated synchronous fast path
  (`renderToStringSync`) covers fully-sync trees.
- **Streaming** (`src/ssr.ts`, `src/server/streaming.ts`): out-of-order
  streaming via placeholder `<div data-async-placeholder="ID">` plus injected
  `$SIGX_REPLACE(id, html)` scripts; three entry points (Web stream, Node
  stream, callbacks); a pump in `streamAllAsyncChunks` races core async
  components against plugin chunk generators.
- **Plugin system** (`src/plugin.ts`): synchronous in-walk server hooks
  (`transformComponentContext`, `handleAsyncSetup`, `afterRenderComponent`),
  post-walk async hooks (`getInjectedHTML`, `getStreamingChunks`), and client
  hydration hooks. This is the right extension surface and the new built-in
  features dogfood it.
- **Hydration** (`src/client/`): marker-driven walk that attaches handlers,
  directives and effects without recreating DOM, with mismatch recovery.
  Client-side state-restoration machinery (`createRestoringSignal`,
  `setPendingServerState`, `generateSignalKey`) already exists.
- **Head management** (`src/head.ts`): `useHead()` collection on the server,
  direct DOM application on the client.

## Findings

Ordered by severity. Line references are to the code at the branch point
(`2b7fb61`).

### F1 — Async pages render twice (perf)

`createSSR().render()` (`src/ssr.ts:252-268`) attempts the sync fast path
with one context, and when the tree contains any async work it discards that
context and re-renders the whole tree through the async generator. Every
async page pays roughly double the render cost.

### F2 — Streaming drops collected head tags (correctness)

All four render methods collect head configs (`ctx.addHead(...)`,
`src/ssr.ts:291/326/389/431`) but no phase ever emits `ctx.getHead()`. In
streaming mode the head HTML is silently lost; in string mode it is only
reachable if the caller holds the context. There is also no document-level
API, so callers hand-splice templates (`examples/spa-ssr/server.ts` replaces
`<!--ssr-outlet-->` manually).

### F3 — Cross-request head contamination (correctness)

`src/head.ts:79-95` keeps `_ssrHeadConfigs`/`_isSSR` in module-level state.
Two concurrent renders that interleave at an `await` mix their head configs.
runtime-core already has AsyncLocalStorage-based per-request isolation
(`packages/runtime-core/src/async-context.ts`); head collection bypasses it.

### F4 — `Suspense` renders its fallback forever on the server (correctness)

Server async handling is keyed entirely off `ssr.load()`. runtime-core's
`Suspense`/`lazy()` register pending promises with the boundary, but nothing
on the server awaits or streams them — `renderToString` of a Suspense tree
returns the fallback, permanently.

### F5 — Prototype-pollution bug in the style cache (bug)

`kebabCache` is a plain object literal (`src/server/render-core.ts:46`), so
`camelToKebab('constructor')` reads `Object.prototype.constructor` (truthy)
and returns the `Function` constructor stringified through `||=`. Needs a
null-prototype object.

### F6 — State restoration is half-built; clients refetch everything (gap)

The client half (restoring signals from captured server state) is fully
implemented and tested, but the server-side capture/emit was never written —
`createTrackingSignal` mentioned in `src/server/types.ts` docs does not
exist. Result: every `ssr.load()` data fetch re-runs in the browser after
hydration (duplicate requests, flicker).

### F7 — Per-vnode AsyncGenerator overhead + a 270-line duplicated walker (perf/maintenance)

Each nesting level of `yield*` re-awaits every chunk: promise allocations and
microtask hops per vnode per level. On a large streamed page this is hundreds
of thousands of avoidable microtasks. The mitigation —
`renderToStringSync` — duplicates ~270 lines of component/attribute logic
that must be kept in sync by hand.

### F8 — `renderToNodeStream` broken in the built package (bug)

Found while wiring benchmarks against the built dist: the library build
bundled for the default browser platform, which stubs `node:stream` to an
empty module — `renderToNodeStream` threw in the published artifact (tests
never caught it because they run against source via path aliases). Fixed by
externalizing `node:` builtins in `packages/server-renderer/vite.config.ts`.

### F9 — No benchmarks, no document API, no asset preloads (gaps)

"Performant" was unmeasurable: no comparative or regression benchmarks.
No API owns the full HTML document (head injection, state script, status-code
decision before first byte, abort handling). No Vite ssr-manifest
integration for `<link rel="modulepreload">` of rendered `lazy()` chunks.

## Roadmap (implemented on `ssr-next` unless marked deferred)

| Stage | What | Findings addressed |
|---|---|---|
| 1 | `benchmarks/` workspace: mitata suites vs Vue / React / Preact, streaming TTFB harness, committed baseline | F9 |
| 2 | Quick wins: `escapeHtml` skip-scan, null-proto kebab cache, allocation trims | F5, F7 (partial) |
| 3 | Core restructure: sync generator + shared buffer, suspension protocol at awaits, delete duplicated sync walker and the double render | F1, F7 |
| 4 | State serialization: resolved async values emitted as the XSS-safe, key-addressed `window.__SIGX_ASYNC__` blob, auto-restored on hydrate (opt-in plugin; automatic in `renderDocument`). *Final API: keyed `useAsync` — the interim `ssr.load`/`__SIGX_STATE__` design was replaced mid-program by the unification in `docs/rfc-use-async.md`.* | F6 |
| 5 | `renderDocument` / `renderDocumentToNodeStream` / `renderDocumentToWebStream`: template + head auto-injection, shell promise for status codes, `AbortSignal`, `mode: 'blocking'` bot/crawler mode; head moved to per-request context | F2, F3, F9 |
| 6 | Suspense-integrated streaming: fallback streamed, content swapped via the existing replace machinery; string/blocking mode awaits real content | F4 |
| 7 | `useStream()`: progressive text streaming (AI/LLM token-style) via `$SIGX_APPEND`, text-only v1. *Originally shipped as `ssr.stream()`, renamed in the `useAsync` unification.* | AI-readiness |
| 8 | `pnpm bench:quick` regression guardrail against the committed baseline | F9 |
| 9 | `examples/spa-ssr` rewritten as the reference integration (document streaming, state serialization, Suspense, LLM-style route, bot mode) | all, end-to-end |
| — | **Deferred**: Vite ssr-manifest → `modulepreload`/stylesheet links for rendered `lazy()` chunks | F9 (remainder) |

### AI-era readiness, concretely

Two deliberate positions rather than speculation:

1. **Serving AI-generated content**: token streams need progressive append,
   not one-shot placeholder replacement. `useStream()` (Stage 7) gives a
   component an `AsyncIterable<string>` whose chunks append into the live
   page over the same SSR stream and finalize into hydratable state.
2. **Being read by AI agents/crawlers**: `renderDocument(..., { mode:
   'blocking' })` (Stage 5) produces complete, semantic HTML with all async
   content resolved inline and zero placeholder divs or bootstrap scripts —
   the app decides per user-agent.

### Compatibility contracts held throughout

- Public APIs (`renderToString`, `renderToStream`, `renderToNodeStream`,
  `createSSR`, `SSRPlugin`) unchanged; all evolution is additive.
- Marker formats (`<!--$c:ID-->`, `<!--t-->`, `<!---->`) and plugin hook
  order are frozen.
- `afterRenderComponent` keeps receiving `''` for streamed components.
- Existing render output stays byte-identical unless a new feature is
  explicitly enabled (the one exception, approved: Suspense trees now render
  real content instead of the fallback — F4 was a bug).
