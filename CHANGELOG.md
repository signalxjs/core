# Changelog

All notable changes to SignalX (`sigx`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While SignalX is on a `0.x` line, breaking changes may land in minor releases — they will always be called out here.

## [Unreleased]

### Added

- **`@sigx/vite`**: `defineLibConfig` takes an `importSource` option — the module the automatic JSX runtime imports from — defaulting to `'sigx'`, so every existing caller is unaffected. It was hardcoded to the `sigx` umbrella, which carries the DOM renderer, leaving non-web platform packages (terminal, lynx) no way to build their own components against their runtime: the only escape was a per-file `/** @jsxImportSource … */` pragma on every `.tsx` source, since oxc honors a pragma over config. Read only when `jsx: true`. (#277)

## [0.10.0] — 2026-07-15

### Changed

- **`@sigx/vite/islands`**: `sigxIslands()` now auto-keys island signal state — `const state = ctx.signal(…)` declarations in island modules are rewritten so the call carries the declaration identifier as its state-serialization key (the key is a transform↔runtime contract, not component API). Keys are namespaced per island boundary record, so reusing common names like `state` across components is safe; signals not bound to a plain declaration stay local-only. Pairs with `@sigx/ssr-islands`' new named-=-transferred state model (see its changelog). (#235)

- **`@sigx/runtime-core`**: production builds now throw compact coded errors — `SIGX### <detail> — see https://sigx.dev/errors/SIGX###/` — while dev builds keep the full message and `suggestion` (dev text unchanged). `error.code` is identical in both modes; only the prod `message`/`suggestion` shape changed. The previously uncoded runtime throws now use `SigxError` with new codes: `SIGX203` (defineFactory setup return type), `SIGX300` (`useData`/`useAction`/`useStream` outside setup), `SIGX400`/`SIGX401` (destroyed topic / topic group) — these were plain `Error`s before. Saves ~0.9 KB brotli across the framework. (#230)

### Added

- **`@sigx/vite`**: `defineLibConfig` now defines the `__DEV__` compile-time flag in both build passes — `false` in the prod-dist pass (dev-only blocks are minifier-stripped, as NODE_ENV guards were), and the runtime `process.env.NODE_ENV !== 'production'` expression in the dev pass (emitted dist is unchanged). Package sources use `__DEV__` for dev-only guards; emitted dists are byte-identical to the NODE_ENV-guard form. (#232)

- **`@sigx/runtime-core`**: dev-only guard on `app.runWithContext` — when the callback returns a Promise (or any thenable), dev builds warn once per app that the context applies only to the synchronous portion (after an `await`, DI lookups silently fall back to realm instances; re-enter with another `runWithContext` call). Return value passes through unchanged; stripped from prod builds. AsyncLocalStorage-backed async continuations were assessed and deferred (browsers have no ALS — revisit when TC39 AsyncContext is cross-platform). (#219)
- **`sigx` / `@sigx/runtime-core`**: required injectables — `defineInjectable<T>('Name')` (name instead of factory) declares a service with **no** global-singleton fallback: used without a provider it throws the new structured `SIGX202` error naming the injectable, and `defineProvide(useX)` without an explicit factory fails the same way. Replaces the hand-written throwing-default-factory idiom for per-app/per-request services (routers, stores). (#213)
- **`@sigx/runtime-core`**: dev-only SSR leak warning — when a factory-form injectable falls back to its module-global singleton **on the server while an app exists** (during a component render or inside `app.runWithContext`), dev builds warn once per token that the instance is shared across all SSR requests in the process. Client-side zero-config usage stays silent; stripped from prod builds. (#213)

- **`@sigx/vite`**: SSR mode (Phase 3 of `docs/rfc-ssr-platform.md` §3, #203): `sigx({ ssr: { entry } })` orchestrates the client + server builds via the environments/builder API — ONE `vite build --app` emits the client bundle with its asset manifest (`dist/client`) and the server entry (`dist/server`, dependencies externalized so the bundle shares one module graph with the production request handler). New `@sigx/vite/ssr` entry: `createDevRequestHandler(vite, { entry })` — the dev server becomes `createServer` plus one handler (per-request `transformIndexHtml` + `ssrLoadModule`, SSR stacks mapped to source, the renderer loaded through the module runner so DI identities stay whole) — and `collectAssets(manifest, entries, base?)`, resolving Vite client-manifest entries (files + transitive static imports + CSS) into the `DocumentOptions.assets` shape. (#206)
- **`@sigx/vite/islands`**: `sigxIslands()` — the plugin the islands manifest option has anticipated since #119. Island modules (`*.island.tsx?` or anything under `islands/`) get `__islandId` stamped on named component exports; importing `virtual:sigx-islands` from the client entry registers a code-split lazy loader per island; the client build emits `.vite/sigx-islands-manifest.json` (`{ chunkUrl, exportName }` per island) for `islandsPlugin({ manifest })` on the server. (#206)
- **`@sigx/server-renderer/node`**: `createRequestHandler({ template, app, document?, isBot?, ssr? })` — the copyable production handler (§3.3, open question 6 as proposed): crawlers get blocking documents, everyone else shell-first streaming; the shell's `{ status, headers, redirect }` writes the response head before the first byte; redirects send no body; shell failures route to `next()`/500. Explicitly not a meta-framework. (#206)
- **`@sigx/server-renderer`**: `DocumentOptions.assets` (`{ modulepreload, stylesheets }`) — manifest-fed links injected before `</head>` in the first flush, plus an automatic `<link rel="modulepreload">` for every boundary chunk recorded during the walk (deduped; URLs escaped; nothing emitted when nothing applies). Closes the deferred `ssr-next` F9 item. (#206)
- **`docs/router-ssr-contract.md`** (§3.2): the router SSR contract — per-request provide + the `createApp(url)` entry contract, route → lazy chunk refs feeding `assets` and the pre-hydration settling rule, miss/guard intent through `useResponse`. Spec'd in core, built in the router repo; `examples/spa-ssr` implements every clause (the hand-wired server collapses to the two handlers, the hardcoded route-chunk preload is gone, one build command replaces the double build). (#206)
- **`@sigx/runtime-core` internals**: `declareLiveClient()` / `isLiveClient()` — an explicit live-client declaration for non-web renderers. `useData`/`useStream` auto-run was gated on `typeof window !== 'undefined'`, which tests "is this a browser", not "is this a live client": on windowless client runtimes (signalxjs/lynx, signalxjs/terminal) reads mounted into `pending` and silently never fetched. Non-web platform-identity modules now call `declareLiveClient()` once on import; without a declaration the browser check remains the fallback, so web and SSR behavior are unchanged. (`@sigx/runtime-dom/platform` deliberately does NOT declare — the `sigx` umbrella evaluates it server-side too.) (#204)
- **`@sigx/cache`**: renderer-portable — depends on `@sigx/runtime-core` + `@sigx/reactivity` instead of the `sigx` umbrella (no DOM renderer in its module graph; module augmentation moved to `@sigx/runtime-core`, reaching `sigx` consumers unchanged), fetch-on-mount rides the live-client signal, and the focus-revalidation event source is pluggable: `cachePlugin({ revalidateTrigger })`, DOM focus/visibility as the web default. (#205)

### Fixed

- **`@sigx/vite`**: the HMR transform no longer injects into SSR transforms — `ssrLoadModule`'d component modules previously received the browser HMR wrapper (and its registry side effects) on the server render path, since the transform keyed only on `command === 'serve'`. (#206)

- **`@sigx/server-renderer`**: `useResponse()` — the per-request response seam (Phase 2 of `docs/rfc-ssr-platform.md` §2.1, #201): components signal `status(code)` / `redirect(location, status?)` / `header(name, value)` during the server render; values collect on the per-request context and surface on the document shell promise as `{ status, headers, redirect }` (the new resolution value of `shell`), so the HTTP layer writes the response head before piping. A redirect short-circuits the body — the chunk stream produces no bytes. Inert outside SSR. (#202)
- **`@sigx/server-renderer`**: `errorScope` works on the server (#201 §2.2): a throw below a scope bubbles to the owning component, which rewinds everything its subtree produced (scoped subtrees suppress mid-subtree flushing so the rewind is always possible) and renders the scope's `fallback(e, retry)` in place — the client's visual contract. The caught boundary is marked in `__SIGX_BOUNDARIES__`; on hydration the scope is seeded errored so the fallback hydrates against the server's fallback HTML and `retry()` performs a real remount. The hydrator now applies the errorScope render wrapper (previously scopes never re-rendered their fallback in hydrated apps). (#202)
- **`@sigx/server-renderer/node`** (new entry, §2.3): `renderToNodeStream`, `renderDocumentToNodeStream`, and a `toNodeStream(chunks | webStream)` adapter for plugin-driven instances. `SSRInstance` gains the runtime-agnostic primitives `renderChunks` and `renderDocumentChunks` (chunks + shell promise). A new CI job (`pnpm test:edge`) streams a document through the production dist with every Node builtin import forbidden — WinterCG cleanliness as a tested guarantee — and the README documents the isolation contract (per-request `SSRContext`; AsyncLocalStorage never required). (#202)
- **`sigx` / `@sigx/runtime-dom`**: `useHead` graduates into the document contract (§2.4): new `base` (last wins), `noscript` and `style` (raw content only through the explicit `innerHTML` opt-in), and `priority` ordering (ascending, ties in call order); `htmlAttrs`/`bodyAttrs` — previously client-only — now patch the document template's `<html>`/`<body>` tags during `renderDocument`. (#202)

### Changed

- **`sigx/internals` / `@sigx/runtime-core`** (internals): typed DI seam tokens — new `createToken<T>(description)` returning a branded `InjectionToken<T>` (a plain symbol at runtime), plus `getProvided`/`setProvided` and a typed `lookupProvided` overload. `ASYNC_ENGINE_TOKEN`, `SSR_SERIALIZER_TOKEN`, `HYDRATE_DEFAULTS_TOKEN`, and `ERROR_SCOPE_TOKEN` migrate, deleting every `as X | undefined` cast at seam reads. Tokens stay plain `Symbol` (never `Symbol.for`) so a duplicated module graph still fails loudly instead of blurring versions. Type-level only; token declarations lose `unique symbol` typing. (#217)
- **`@sigx/runtime-core`**: `app._context` (and `_rootComponent`) are no longer `@internal` — they are documented as the stable plugin-author surface: inside `install(app)`, pass `app._context` to seam provide-helpers or use its `provides`/`disposables` directly. `@sigx/ssr-islands` and `@sigx/server-renderer`'s client plugin drop their `(app as any)` casts accordingly; the runtime-core README gains a "Writing plugins" section. No runtime change. (#218)
- **`@sigx/runtime-core`** (behavior, pre-1.0): an explicitly provided `undefined` now shadows an injectable's fallback instead of falling through to it — `defineProvide(useX, () => undefined)` resolves to `undefined` (internal lookups distinguish "not provided" from "provided `undefined`"). (#213)
- **`@sigx/runtime-core`** (behavior, pre-1.0): app-level provides are read **live** through the root `AppContext` instead of being copied onto the root component at mount — `app.defineProvide` calls made after `app.mount()` are now visible to components mounted afterwards. Precedence is unchanged: component-tree provides still win. (#213)
- **`@sigx/server-renderer`** (breaking, pre-1.0): ONE error seam (§2.2) — `SSRContextOptions.onError(error, info)` with `info: { phase: 'shell' | 'stream', componentId?, componentName?, boundaryId? }` receives per-component render failures on both the synchronous and the streamed path, plus request-level shell/stream failures (phase-only info); `renderError(error, info)` is the configurable failure HTML (default: the stable `<!--ssr-error:ID-->` comment, plus a visible diagnostic box in development). The hard-coded `<div style="color:red;">` streamed-failure markup is deleted. `DocumentOptions.onError`'s second parameter is now the info object instead of a bare phase string. (#202)
- **`@sigx/server-renderer`** (hardening): head attribute escaping now covers `<`/`>` (was `&`/`"` only), and raw `innerHTML` content for script/style/noscript neutralizes closing-tag sequences (`</tag` → `<\/tag`) so a payload cannot terminate its element — script innerHTML was previously emitted fully raw. (#202)

### Removed

- **Breaking** (`@sigx/server-renderer`): `SSRContextOptions.onComponentError` (folded into `onError` + `renderError`), and `SSRInstance.renderNodeStream` / `SSRInstance.renderDocumentToNodeStream` plus the `./server` exports of `renderToNodeStream` / `renderDocumentToNodeStream` — the Node Readable shapes live in `@sigx/server-renderer/node` (wrap `renderChunks` / `renderDocumentChunks` with `toNodeStream` for plugin instances). (#202)

- **`@sigx/server-renderer`**: the SSR boundary model (Phase 1 of `docs/rfc-ssr-platform.md` §1, #199): `SSRBoundary` with two orthogonal axes — `flush: inline|stream|skip` × `hydrate: load|idle|visible|media|interaction|never` — decided by the new pre-setup `resolveBoundary` plugin hook (first plugin wins, consulted after id allocation but before the setup context is built and `__setup` runs). `flush: 'skip'` is true skip-SSR: setup never runs and core emits a `<div data-boundary="ID" style="display:contents;">` wrapper (the client's mount container) around an optional `fallback` vnode; `flush: 'stream'` degrades to inline when there is nothing to defer, and a stream boundary's `fallback` renders inside the placeholder in place of the initial-state pass. Accepted boundaries are recorded in a per-request table (`SSRContext._boundaries`, `recordBoundary`/`getBoundary`) and emitted as `window.__SIGX_BOUNDARIES__` — an executable null-prototype assignment sharing the `__SIGX_ASYNC__` serializer discipline; empty tables emit nothing, so boundary-free pages are byte-identical. Mid-stream, core re-emits a resolved boundary's record as the `$SIGX_REPLACE` preScript so post-async state mutations land before `sigx:async-ready`. (#200)
- **`@sigx/server-renderer/client`**: selective hydration is THE hydrator (rfc-ssr-platform §1.2): the boundary hydrator reads `__SIGX_BOUNDARIES__` and schedules each boundary per strategy — including the new **`interaction`** strategy (first pointerdown/keydown/touchstart/focusin; once, passive, no event replay) and `never`. Per-app hydration defaults ride a new DI seam (`HYDRATE_DEFAULTS_TOKEN` / `provideHydrateDefaults`): `boundaries: 'explicit'` hydrates only table entries with no root walk (islands mode), the `'auto'` default walks and intercepts recorded boundaries — a page with only `hydrate: 'load'` boundaries degenerates to today's single walk and a page with no table pays nothing. The component registry, chunk loader, boundary-state staging (#120 hand-off), and the streamed-boundary (`sigx:async-ready`) flow move here from `@sigx/ssr-islands`; `beforeHydrate → false` stays as the resumability escape hatch. (#200)
- **`sigx/internals` / `@sigx/runtime-core`**: `SSR_SERIALIZER_TOKEN` / `provideSSRSerializerHandlers` — a per-app type-handler registry for SSR state serialization (`SSRTypeHandler`: `test`/`serialize`, handlers see raw values before `toJSON`), mirroring the `provideAsyncEngine` seam from #195. Handlers reach `__SIGX_ASYNC__` and the boundary table through one shared serializer module. (#200)
- **`@sigx/ssr-islands`**: the `client:interaction` directive, and a pluggable app mode — `app.use(islandsPlugin())` declares islands hydration (`install()` provides `{ boundaries: 'explicit' }` through the core seam and registers the client hooks), so `app.hydrate('#app')` schedules only islands; package installation alone never changes page semantics. (#200)

### Changed

- **`@sigx/ssr-islands`** (breaking, pre-1.0): rebuilt as the reference pack on the boundary model — `resolveBoundary` maps `client:*` directives onto boundary records (`client:only` decomposes into `flush: 'skip'` + `hydrate: 'load'`), captured signal state (#120) writes into the core record, and the client scheduler/registry/chunk-loader modules become facades over the core hydrator. **`__SIGX_ISLANDS__` is gone** — replaced by the core `__SIGX_BOUNDARIES__` table — and the skip-SSR placeholder attribute is now `data-boundary` (was `data-island`). The pack keeps zero privileged access. (#200)

### Removed

- **Breaking** (`@sigx/server-renderer`): the `suppressComponentRender` and `handleAsyncSetup` plugin hooks — both fold into `resolveBoundary` (the one sanctioned frozen-contract revision, rfc-ssr-platform §1.3; no deprecated aliases). Consequences: the old async `'skip'` mode (run setup, render nothing) is no longer expressible, the `handleAsyncSetup` placeholder-string override is gone (the `data-async-placeholder` wrapper is a frozen core literal), and core always owns the deferred render — plugin-owned streams remain via `getStreamingChunks`. (#200)

- **`@sigx/cache`** (new package): cache POLICY for value-first async, riding the rfc-async §7 pack contract (#195). `app.use(cachePlugin())` installs a per-app engine; call sites opt in via the `cache` option the pack's module augmentation adds to core's open `AsyncOptions`/`ActionOptions`: `staleTime` (fresh values serve without fetching; stale ones serve immediately and revalidate as `'refreshing'`), `gcTime` retention across unmounts, `revalidateOnFocus`/`revalidateOnInterval`, `keepPreviousData` across key changes, `invalidate()`/`mutate()` write-through on cached reads, and per-action `invalidates` (exact keys or tuple prefixes) + `optimistic` apply with conditional rollback. Adopts `__SIGX_ASYNC__` as its initial cache state (blob-as-seed); reads/actions without `cache` options delegate to core's default engine verbatim.
- **`@sigx/runtime-core`**: the §7 provider seam is now installable per app — `useData`/`useAction` resolve an app-provided `AsyncEngine` (DI token, `provideAsyncEngine` + the delegable `defaultAsyncEngine` exported via internals) when no SSR per-instance provider is present. Core's key machinery (getters, canonical tuple identity, dev guards) stays in front of any engine; the SSR `_useAsync` seam is unchanged and still takes precedence. (#195)

### Fixed

- **`@sigx/runtime-core`**: an element vnode passed **as a component prop** (a fallback, an icon, an array of items) now reaches the renderer as its raw object. Previously the reactive props proxy wrapped it — and, transitively, its dom node — corrupting the renderer's bookkeeping when the vnode toggled out of the tree: text children were removed while their element stayed behind, later mounts landed at the container end, and re-showing or unmounting threw inside the DOM (`removeChild ... is not a child of this node`). The props accessor now unwraps vnode-shaped values (the prop read itself stays reactive, so replacing the prop re-renders as usual), and `<Defer>`'s interim `toRaw` workaround is removed. (#191)

## [0.9.0] — 2026-07-13

Value-first async lands (Phase 1 of `docs/rfc-async.md` rev 8, #189): one reactive async-cell concept exposed as a read/write pair — `useData` (keyed reads) and `useAction` (manual writes) — rendered with co-located `match`, coordinated with `all()`, with one thin tree wrapper `<Defer>` and setup-time `errorScope` replacing the React-style `<Suspense>`/`<ErrorBoundary>` wrappers. Pre-1.0, no-compat: the old primitives are removed outright.

### Added

- **`sigx` / `@sigx/runtime-core`**: `useData(key, fetcher, opts?)` — THE keyed async read. Key is mandatory (data always has identity): a static string, or a reactive getter returning a string or a tuple of JSON primitives (canonical-JSON identity; a falsy getter result skips the fetch — state `'idle'`). The key is the fetcher's first argument (one shape everywhere: `(arg, ctx) => Promise<T>`); fetchers run untracked (dev warns on a signal read inside one). `AsyncState` gains a `state` enum (`idle | pending | ready | refreshing | errored`) and `match(arms)` — the typed path to a non-null value, with an `idle` arm and `(error, retry, stale)` in the error arm. Pinned semantics: key change hard-resets (value cleared, `'pending'`); same-key `refresh()` keeps the value (`'refreshing'`); `loading === (state === 'pending')` only; `refresh()` never rejects; a superseded run never writes state or `.error`; the underlying fetch aborts only when unshared (the in-flight dedupe map stays). `{ server: false }` keeps a read client-only (SSR renders the pending arm). (#189)
- **`sigx` / `@sigx/runtime-core`**: `useAction(fn, opts?)` — the manual write counterpart. Never auto-runs; `run(input)` never rejects (resolves `RunResult<T>`; `SupersededError` is exported and distinguishable); in-flight requests are never aborted; `retry` re-runs the last input; `reset()` returns to `'idle'`. `ActionOptions` is an open, deliberately empty interface — packs augment it. (#189)
- **`sigx` / `@sigx/runtime-core`**: `all()` — combine reads for all-or-nothing gating: object form (named `value`/`errors` records) and rest-tuple form; first-error-wins `.error` with collect-all `.errors`; combined `refresh()` refreshes every member in parallel; any idle member holds the combination at `'idle'`, any refreshing member (all values present) keeps the ready arm rendering. (#189)
- **`sigx` / `@sigx/runtime-core`**: `<Defer fallback={…}>` — the one tree-positional async wrapper. Client: covers lazy chunk loading only (pending data renders through the owning component's `match`). SSR streaming: the fallback flushes with the shell and ONE replacement arrives when everything pending beneath it — lazy chunks and keyed `useData` reads — resolves. (#189)
- **`sigx` / `@sigx/runtime-core`**: `errorScope({ fallback, onError })` — setup-time call scoping the calling component's subtree via DI. Catches descendant setup/render/re-render throws (`handleComponentError` walks the instance parent chain, nearest scope first, before plugin hooks and the app handler — and even without an app context); `retry` genuinely remounts the subtree (descendant effects stopped, `onUnmounted` run) rather than flipping a flag. Does not catch fetcher rejections (they land on `.error`) or event-handler throws. (#189)
- **`sigx` / `@sigx/runtime-core`**: chainable `app.onError(handler)` — the app-level error handler (renames `app.config.errorHandler` to `config.onError`). Unhandled data errors from a `match()` without an `error` arm bubble here (info `'async'`) after the errorScope walk. (#189)
- **`@sigx/runtime-dom`**: DOM event-handler and model write-back throws now route through `handleComponentError` (info `'event handler'`, instance `null`) — a returning-`true` app `onError` swallows them; otherwise they rethrow as before. `patchProp` gained an optional trailing `appContext` parameter (renderer-internal). (#189)

### Changed

- **`@sigx/server-renderer`**: `serverUseAsync` returns the new `AsyncState` shape (state enum + `match`); server cells are only ever `pending`/`ready`/`errored`. Data errors on the server are always SOFT — the component renders its error arm; a rejecting keyed read no longer routes to the component error fallback / red streaming replacement (setup throws still do). `{ server: false }` renders the pending arm. Wire format, request-level dedupe, and the `_useAsync`/`_useStream` provider seams are unchanged; tuple keys serialize under their canonical JSON string. (#189)
- **`@sigx/runtime-core`**: `lazy()` rebuilt without the thrown-promise protocol: the wrapper reads a factory-level load signal, renders `null` while the chunk loads, registers with the nearest `<Defer>` at setup time via DI, and a rejected chunk throws from render into the standard error path (nearest `errorScope`, then app `onError`). `preload()`/`isLoaded()`/`isLazyComponent` are unchanged. (#189)
- **`@sigx/runtime-core`**: async options flow through the provider seam whole (open `AsyncOptions`/`ActionOptions` interfaces — packs augment them, per the RFC §7 pack contract); the default engine dev-warns on option keys no installed pack handles. (#189)

### Removed

- **Breaking**: `useAsync` (replaced by `useData` — every call site gains the leading key argument in the fetcher: `(ctx) => …` becomes `(key, ctx) => …`), the unkeyed bare-fetcher form (use `{ server: false }` with a key), the `throwOnError` option (errors are always values; render them via the `error` arm), `<Suspense>` (+ `SuspenseProps`), `<ErrorBoundary>`, the throw-a-promise protocol and `registerPendingPromise`, the suspense-boundary async-context APIs, and `app.config.errorHandler` (now `config.onError` / `app.onError()`). (#189)

## [0.8.0] — 2026-07-13

Performance-and-correctness release from a full review of the reactivity and renderer hot paths: the keyed diff is now LIS-based (Vue-3-style), effect re-runs reuse their dependency links instead of tearing down and re-subscribing, and a batch of real bugs found during the review — SVG namespace inconsistencies, dropped falsy keys, keyed fragment/component reorders losing their content, and a throwing effect wedging its siblings — are fixed.

### Changed

- **`@sigx/reactivity`**: effect and computed re-runs reuse their dependency links (Vue 3.4-style active-link reuse) instead of full teardown plus re-subscription — a stable re-run performs zero allocations and zero Set operations per tracked read, and duplicate reads within a run dedup for free. Re-tracking an effect with 50 stable dependencies is ~1.36x faster; the two-pass mark/flush, queued-effect dedup, and value-change cutoff semantics are unchanged. (#162)
- **`@sigx/runtime-core`**: keyed reconciliation is Vue-3-style — prefix/suffix sync plus a longest-increasing-subsequence pass that moves only the nodes outside the stable subsequence (a 100-row benchmark shuffle drops from ~99 DOM moves to 76; swaps move exactly the two displaced rows). Elements with a single unchanged-type child skip the reconcile machinery entirely (2–4x faster partial updates in benchmarks). (#163, #184)
- **`@sigx/reactivity`**: hot-path allocation work throughout — the exotic-builtin check (`shouldNotProxy`) exits plain objects and arrays on two pointer compares with a per-prototype verdict cache (reads of Date/typed-array values ~1.5–2.3x faster), array mutators and multi-dep writes batch without per-call closures, `$set` is one stable closure per proxy (`state.$set === state.$set`), collection methods are no longer re-bound per access (`m.set === m.set`), and the nested-object cache allocates lazily. (#173, #177, #181)
- **`@sigx/runtime-core`**: `jsx()` clones component props once instead of twice per vnode and the model path avoids an `Object.keys` allocation — component mounting is measurably cheaper. (#152)

### Fixed

- **`@sigx/runtime-core`**: reordering keyed **fragment or component** children now moves their entire rendered content. Previously the reconciler moved only the child's trailing anchor comment (`vnode.dom`), leaving the fragment's nodes / the component's subtree behind in the old position. Keyed reconciliation also now minimizes DOM moves with a longest-increasing-subsequence pass (Vue-3-style): a reorder moves only the nodes outside the stable subsequence instead of nearly every displaced node. (#184)
- **`@sigx/runtime-core`**: falsy JSX keys are no longer dropped — `key={0}` and `key=""` now actually key their elements instead of silently falling back to positional diffing. Keys are also normalized to strings once at vnode creation, so keyed reconciliation compares them without per-diff coercion (`key={1}` still matches `key="1"`). (#169)
- **`@sigx/reactivity`**: an effect that throws mid-notification-wave no longer permanently wedges the other effects queued in the same wave. Previously the abandoned effects kept their internal queued flag while being dropped from the queue, so no later write could ever re-run them. (#179)
- **`@sigx/runtime-core`**: SVG namespace handling is now consistent between mount and patch. Previously patch re-derived SVG-ness from the tag name alone, so HTML elements whose names also exist in SVG (`title`, `text`, `image`, …) were patched down the SVG attribute path, elements inside `<foreignObject>` were misclassified, components mounted inside an `<svg>` rendered their subtree in the HTML namespace, and a child newly mounted during a fragment patch inside an `<svg>` (or a component swapping its root element type) lost the namespace entirely. The namespace is now computed once at mount, cached on the vnode, and threaded through fragment patches, type replacements, and component mounts. (#166)
- **All packages**: published tarballs now include `src/`, so the shipped declaration maps (`dist/*.d.ts.map`) resolve and go-to-definition from `node_modules` lands in real TypeScript source instead of a missing file. (#158)
- **`@sigx/vite`**: the `sigx-types` CLI advertised in the README is now actually installable — the package manifest was missing its `bin` entry, so `npx sigx-types` could not resolve it. Also reordered the package's `exports` conditions to list `types` first, matching every other package. (#150)

## [0.7.0] — 2026-06-15

Slot-presence semantics fix: a slot is now a callable accessor only when the parent actually provided content for it — `default` included — and reads as `undefined` otherwise. This makes presence a plain truthiness / optional-call check and resurrects the documented `slots.x?.() ?? fallback` pattern, which previously could never render its fallback.

### Added

- **`@sigx/server-renderer`**: new `suppressComponentRender(id, vnode, ctx)` server plugin hook. It runs after a component's context is built (so `transformComponentContext` has run and the id is assigned) but before `setup()`/render, and lets a plugin skip running the component entirely and emit a placeholder string in its place — the seam needed for true skip-SSR. Returning `{ placeholder }` suppresses the component's `setup`/render and its `afterRenderComponent` call; core still emits the trailing `<!--$c:id-->` marker so hydration anchors correctly. Works in both string and streaming modes. (#122)
- **`@sigx/ssr-islands`**: `client:only` islands now genuinely skip SSR. Instead of rendering and hydrating in place like `client:load`, the component is no longer run on the server — an empty `<div data-island>` placeholder is emitted (the island still appears in `__SIGX_ISLANDS__`, with no captured state) and the client mounts the component fresh into it. Built on the new `suppressComponentRender` hook. The dev warning that `client:only` behaved like `client:load` is removed. (#122)
- **`@sigx/server-renderer`**: client-side `transformComponentContext` hook on `SSRPlugin.client`, the hydration-time mirror of `SSRPlugin.server.transformComponentContext`. It is invoked after a component's `ComponentSetupContext` is built but before `setup()` runs during hydration, receiving `(vnode, componentCtx)` and able to mutate or replace the context (e.g. swap `ctx.signal`). This restores server/client symmetry — hydration is now as pluggable as render — while keeping core strategy-agnostic (no `client:*`/islands knowledge). (#120)
- **`@sigx/ssr-islands`**: island components now restore their server-captured signal state on hydration. The pack implements the new client `transformComponentContext` seam to swap `ctx.signal` for a restoring variant that seeds each signal from the captured `__SIGX_ISLANDS__[id].state` (falling back to the literal initial), so an island resumes from its server value instead of re-initialising. The previously inert `initIslandHydration` wiring hook is removed. (#120)

### Changed

- **`@sigx/runtime-core` (breaking)**: slot accessors now reflect presence. Previously the slots object returned a callable for *every* key and empty slots returned `[]`, so `slots.header` was never `undefined`, optional chaining never short-circuited, and `slots.header?.() ?? fallback` was dead code — the fallback could not render. Now a slot — `default` and named slots alike — is a function only when content was provided for it and is `undefined` when it was not, so presence is a normal `slots.x` truthiness / `slots.x?.()` / `slots.x?.() ?? fallback` check. Presence stays reactive: a slot appearing or disappearing across a re-render flips the accessor between a function and `undefined` and re-renders the consumer; a slot supplied via the `slots` prop counts as present regardless of what it returns. Type-level, `default` and declared slots are now optional on the slots object, surfacing the few call sites that assumed presence as type errors. **Migration:** call slots optionally — `slots.default?.()` instead of `slots.default()` — since an unprovided slot (including `default` on a childless component) is now `undefined` and calling it directly throws. (#42)

### Removed

- **`@sigx/runtime-core`**: the deprecated flat type aliases `DefineProp`, `DefineModel`, `DefineEvent`, `DefineSlot`, and `DefineExpose` have been removed. Use the canonical `Define.*` namespace instead — `Define.Prop`, `Define.Model`, `Define.Event`, `Define.Slot`, `Define.Expose`. These aliases were `@deprecated` shims; since SignalX is still pre-1.0 they are dropped outright rather than carried. (#48)

### Fixed

- **`@sigx/server-renderer`**: server-side slot construction now mirrors the client slot extractor, so server and client agree on which slots are present (previously the server exposed `default` unconditionally and never separated `slot`-prop children into named slots). Un-slotted children form the `default` slot, `slot`-prop children group into their named slots, and a slot is present only when it has content — keeping `slots.x?.() ?? fallback` consistent across SSR and client and avoiding hydration mismatches. (#42)

## [0.6.3] — 2026-06-13

Hydration-robustness patch: a structural mismatch between the server-rendered DOM and a component's first client render is now self-healing — sigx discards the abandoned SSR subtree and re-renders it on the client instead of leaving duplicate/orphaned content visible.

### Fixed

- **`@sigx/server-renderer`**: a structural hydration mismatch at the top of a component's subtree is now self-healing instead of leaving orphaned server-rendered nodes visible. When a component's first client render diverged structurally from the SSR DOM (e.g. the server rendered an empty-state placeholder but the client renders a populated list — common when client and server data differ, and acute with `lazy()` components that hydrate after a client fetch resolves), the hydrator bound the client VNode to a freshly created element but left the non-matching SSR nodes in place, so both the client tree and the abandoned server content stacked in the DOM (with an `[Hydrate] Expected element but got: …`/`got: null` warning cascade once the cursor diverged). The component hydrator now detects this top-of-subtree mismatch (the client's leading element tag differs from the element SSR produced for the component), discards the component's SSR DOM range — bounded by its trailing marker, so only that component's content is removed — and mounts the client subtree fresh in its place (React/Vue "bail to client render for this subtree" semantics). A mismatch may cost a re-mount, but it no longer leaves duplicate or unowned content. Residual: an element-level structural mismatch deep inside an already-hydrating subtree (no component boundary to bound the removable range) still falls back to mount-fresh and is not cleaned up — the high-value component-subtree case (including nested child components and the lazy/late-fetch empty-state-vs-list case) is covered. (#115)

## [0.6.2] — 2026-06-13

Stability patch: component `setup()` (and created/mounted hooks) now run untracked in both the mount and hydration paths, eliminating a class of unbounded re-render loops diagnosed in a production app; development builds turn any remaining runaway render/effect loops into actionable errors instead of a frozen page.

### Added

- **`@sigx/runtime-core` / `@sigx/reactivity`**: dev-mode runaway-loop guards. When a component's render writes reactive state that some render depends on (directly, or through a store action called mid-render), the synchronous flush used to re-queue itself forever — the page froze solid with zero feedback. Development builds now throw an actionable error instead: the render scheduler bounds each flush (a per-job re-queue counter catches ping-pong loops between existing components; a total-flush-length bound catches loops that remount fresh components each iteration), and the reactivity layer bounds each notification wave (`Runaway notification wave`) for runaway effect cascades outside the render queue. Limits sit far above anything a legitimate update produces; all checks are compiled out of production builds. Loops re-triggering on microtask cadence (each write in its own flush) remain undetectable by design. (#111)

### Fixed

- **`@sigx/runtime-core` / `@sigx/server-renderer`**: component `setup()` — and the `created`/`mounted` hooks that run during mounting — now run untracked, in both the renderer's mount path and the client hydration path. Children mount synchronously inside the parent's render effect, so every reactive read in a descendant's setup registered as a dependency of the *ancestor's* render effect — a later write to any such signal re-rendered the ancestor, remounted descendants (re-running their setups), and could re-queue the flush forever (observed as a full-page freeze in a production app after one store write). Reactive reads in setup now subscribe nothing, matching refs and mount hooks, which were already untracked; component reactivity belongs to the per-component render effect and explicit `watch`/`computed` scopes, which create their own subscriptions and are unaffected. (#111)

## [0.6.1] — 2026-06-12

Companion-alignment release: `app.runWithContext` (additive), the vite plugin's dev-mode fixes for companion packages (optimizeDeps/`ssr.noExternal`/HMR), the `sigx:ready` signal in blocking document mode, plus the post-0.6.0 packaging and registration work (dual dev/prod dists, layered directive registration, the islands runtime moving fully to `@sigx/ssr-islands`). Released as a patch so it stays inside the `>=0.6.0 <0.7.0` peer range the companion packages declare; the breaking entries below complete the 0.6 islands/directives reshuffle already coordinated with those companion releases.

### Added

- **`@sigx/runtime-core`**: `app.runWithContext(fn)` — runs `fn` with the app's context as the current DI context, so use-functions from `defineFactory`/`defineInjectable` (and `useAppContext()`) called outside component setup — router navigation guards, socket handlers, entry-scope code — resolve to the app's instances, the same ones components receive, instead of silently splitting state into the realm-level fallback. The context applies to the synchronous portion of `fn` only (re-enter after `await`); nested calls restore the previous context; behavior outside `runWithContext` is unchanged. Plugins receive the app in `install()` and can capture it to wrap their callbacks. (#101)
- **`@sigx/runtime-core`**: `registerModelProcessor(fn)` — extension tier for intrinsic-element model handling. Extension processors run before the platform processor (first returning `true` wins), so packs and apps can ADD model behaviors (custom elements, widget libraries) without replacing the platform's. `setPlatformModelProcessor` is unchanged — platform packages (DOM, Lynx, Terminal) keep registering their processor as part of platform identity. (#77)
- **all packages**: dual dist builds — every package now ships `dist/*.js` (development: runtime `process.env.NODE_ENV` checks, dev warnings, devtools hook) alongside `dist/*.prod.js` (production: warnings and the devtools integration compiled out). Bundlers pick the right one automatically through the `development`/`production` export conditions (Vite needs no configuration); resolvers without those conditions keep getting the development build, which consumer-side `NODE_ENV` defines still strip — the status quo. Plain Node SSR can opt into the stripped build with `--conditions=production`. (#67)
- **`@sigx/vite`**: `defineLibConfig` is now mode-aware — `vite build --mode prod-dist` emits the production dist (`.prod.js` suffix, `NODE_ENV` defined away) next to the default build. This is the sigx-standard mechanism; other sigx repos adopt dual dists by upgrading `@sigx/vite`, adding the second build pass, and mirroring the export-conditions map. (#67)
- **`@sigx/vite`**: `hmrPort` plugin option, plus automatic free-port selection for Vite's HMR websocket when the dev server runs in middleware mode — Vite's fixed default there (24678) collides as soon as two dev servers run on one machine: the browser connects to the *other* server's websocket, fails with a 400 token mismatch, and HMR breaks. Explicit `server.hmr` settings in the Vite config always take precedence. (#102)

### Changed (breaking)

- **`sigx` / `@sigx/runtime-core`**: the islands directive runtime moved out of core to `@sigx/ssr-islands`, which already owned the `client:*` types. Removed: the `sigx/hydration` subpath, `CLIENT_DIRECTIVE_PREFIX` / `CLIENT_DIRECTIVES` (and the `ClientDirective` / `HydrationStrategy` / `HydrationDirective` types) from the public barrel, and `filterClientDirectives` / `getHydrationDirective` / `hasClientDirective` / `serializeProps` from internals. Core's client hydrator no longer strips any directive prefix — strategy packs filter their own marker props before delegating (the existing client-plugin hooks are the interception seam). (#80)

- **`@sigx/runtime-dom`**: directive registration is layered. Standard built-in directives (`show`) register automatically via the platform side-effect entry — their JSX types are globally visible, so the runtime always resolves them. Custom and pack directives register per app with `app.directive(name, def)` (works on the client and during SSR) or globally with `registerBuiltInDirective(name, def)`. Model handling is unchanged: the DOM form model processor remains automatic (platform identity, like Lynx's). New `JSX.DirectiveAttribute<T, El>` alias types a directive's `use:*` attribute in one line. (#77, #86)
- **`sigx` / `@sigx/runtime-dom`**: the DOM form model processor now ships as its own dist entry (`@sigx/runtime-dom/platform`), named precisely in `sideEffects`; `sigx` keeps a precise `sideEffects` allowlist (its entries carry the platform import) and imports it by subpath. Packages tree-shake fully (unused `Portal`/`useHead`/`show` drop from app bundles) while platform side effects are bundler-proof — previously they survived only by entry-statement retention. (#77)
- **`@sigx/server-renderer`**: the internal lazy patching of `getSSRProps` onto built-in directives is gone — `show` now declares its own `getSSRProps`, and the hook is part of `DirectiveDefinition` in `@sigx/runtime-core` proper (directives are isomorphic). The `DirectiveDefinitionExtensions` augmentation seam remains for other extensions. (#77)

### Changed

- **`@sigx/reactivity` / `@sigx/runtime-core`**: all devtools emission paths (signal/computed/effect lifecycle events, app and component notifications, owner attribution) are gated behind `process.env.NODE_ENV !== 'production'` so production builds carry zero devtools plumbing. Devtools keep working in development builds exactly as before. (#67)

### Fixed

- **`@sigx/server-renderer`**: `renderDocument*` in `'blocking'` mode now emits the completion script (`window.__SIGX_STREAMING_COMPLETE__ = true` + the `sigx:ready` event) at the end of the body, exactly like streaming mode. Previously only streaming mode emitted it, so clients gating hydration on the flag/event (the documented pattern) never hydrated blocking-rendered pages — forms fell back to native submits. A blocking document is complete when delivered, so the signal is semantically correct; blocking output still contains no placeholders or `$SIGX_REPLACE` scripts. The fragment-level APIs (`renderToString` / `createSSR().render()`) are unchanged — they never emitted bootstrap scripts and their output stays stable. (#100)
- **`@sigx/vite`**: the HMR runtime now sets the current component instance around the setup re-run on hot updates (mirroring the renderer's mount path). Previously the re-run executed user setups with no current instance, so module-level lifecycle hooks (`onMounted`/`onUnmounted`/`onCreated`/`onUpdated` imported from `sigx`) warned `onX called outside of component setup` and silently dropped the registration — cleanups registered by the new setup body were lost, leaking listeners/subscriptions across hot updates. (#105)
- **`@sigx/vite`**: dev-mode module-instance split with companion packages. The plugin now excludes **all** `@sigx/*` packages from `optimizeDeps` — the hardcoded core list plus every `@sigx/*` dependency/devDependency enumerated from the project's `package.json` — and sets `ssr.noExternal: ['sigx', /^@sigx\//]`. Previously only the five core packages were excluded, so companions (`@sigx/store`, `@sigx/router`, `@sigx/daisyui`, …) were esbuild-prebundled into `.vite/deps` chunks carrying a **second** `@sigx/reactivity` instance — store/router signals never reached the renderer's effects (silently dead UI in dev, even with a single installed copy of every package). The same split existed server-side between the SSR module-runner graph and Node-loaded externalized packages. User-specified `optimizeDeps.exclude` / `ssr.noExternal` entries are merged with, not replaced by, the plugin's. (#102)
- **`@sigx/server-renderer` / `@sigx/runtime-dom`**: nullish and `false` values for `style` and `className` now omit the attribute entirely. SSR previously rendered `style="undefined"` for unset pass-through style props (`<div style={props.style}>`) because the `style`/`className` serialization branches ran before any null check; the client-side `patchProp` now clears the attribute for falsy values symmetrically, matching the pre-existing behavior of generic attributes. (#98)

## [0.6.0] — 2026-06-11

The SSR engine release (#61, #65): a ~5× faster streaming core measured against Vue/React/Preact, document-level rendering with an AI-agent serving mode, server-side Suspense, and ONE unified data-loading story — `useAsync`/`useStream` with automatic hydration state transfer. Breaking changes below (0.x line).

### Added

- **`sigx`**: `useAsync` — THE data primitive. `useAsync(fn)` is client-only; `useAsync(key, fn, opts)` runs on the server, serializes its resolved value under the explicit key into `window.__SIGX_ASYNC__` (page-lifetime cache, prototype-pollution-safe), restores on hydration without refetching, and dedupes per request/page by key. `AsyncState` gains `refresh()` (stale-while-revalidate; repopulates the cache); fetchers receive an `AbortSignal`; `value`/`error` are mutually exclusive; `{ throwOnError }` routes to error boundaries. (#61)
- **`sigx`**: `useStream(key, source)` — progressive text streaming for AI/LLM-token content: tokens append into the page over the initial response (`$SIGX_APPEND` text nodes, XSS-safe by construction), the final markup swaps in through the standard replacement pipeline, and the final text hydrates from the key. Text-only v1. (#61)
- **`sigx`**: `useHead` moved into core (browser-standalone: mutates `document.head`, cleans up on unmount, dedups meta incl. `charset`; SSR collects per-request via the instance seam). Import from `'sigx'`. (#61)
- **`@sigx/server-renderer`**: `renderDocument` / `renderDocumentToNodeStream` / `renderDocumentToWebStream` — the engine owns the complete HTML response: template + `<!--ssr-outlet-->`, automatic head injection (streaming previously lost collected heads), automatic state serialization (`serializeState: false` to opt out), `AbortSignal`, `onError(e, 'shell' | 'stream')`. The node variant returns `{ stream, shell }` — `shell` settles before the first byte for status-code decisions. `mode: 'blocking'` serves crawlers/AI agents complete inline content with no placeholders or streaming scripts. Entry scripts flush with the shell (downloads start immediately; module execution can't race hydration). (#61)
- **`@sigx/server-renderer`**: Suspense and `lazy()` now actually render on the server — lazy resolves inline; streaming mode emits the fallback and swaps in real content via the replacement machinery. Hydrating server-resolved Suspense content requires preloading the lazy chunk before `hydrate()`. (#61)
- **`@sigx/server-renderer`**: `SSRPlugin.onAsyncComponentResolved` may return `preScript` — script content injected BEFORE the `$SIGX_REPLACE` call (state must install before hydration listeners fire). (#61)
- **benchmarks/** workspace (not published): comparative SSR suites vs Vue/React/Preact with equivalence-verified trees, streaming TTFB harness, committed baseline, and the `pnpm bench:ssr:quick` regression guardrail. (#61)

### Changed (breaking)

- **`@sigx/server-renderer`**: `ssr.load()` and `ssr.stream()` are REMOVED — use keyed `useAsync`/`useStream` from `sigx`. `ctx.ssr` is now `{ isServer, isHydrating }` only. The signal-name serialization machinery is removed: `createTrackingSignal`, `createRestoringSignal`, `setPendingServerState`, `generateSignalKey`, `SSRSignalFn`, positional `$N` keys, and the per-component `window.__SIGX_STATE__` blob (replaced by the key-addressed `window.__SIGX_ASYNC__`). `hydrateComponent`'s signature drops the `serverState` parameter. `enableSSRHead`/`collectSSRHead` are removed (head collection is per-request on the SSRContext). `useHead` is no longer exported from `@sigx/server-renderer` — import from `'sigx'`. (#61)
- **`sigx`**: `useAsync(fn)` no longer fires its loader during SSR (it previously started it, never awaited it, and leaked an unhandled promise while baking the loading state into the HTML). Existing unkeyed call sites keep compiling; behavior on the client is unchanged. (#61)
- **`@sigx/server-renderer`**: `renderToString` of a Suspense tree now returns the awaited content instead of the fallback (the old behavior was a bug, but output changes). (#61)

### Fixed

- **`@sigx/server-renderer`**: `renderToNodeStream` was broken in the published artifact — the lib build stubbed `node:` builtins for the browser platform. (#61)
- **`@sigx/server-renderer`**: streaming responses dropped all `useHead` tags; concurrent renders could cross-contaminate head configs through module-level collection. Head handling is per-request and document-injected. (#61)
- **`@sigx/server-renderer`**: hydrating streamed async components duplicated their content — the walk mismatched on the `data-async-placeholder` wrapper and mounted a fresh copy below the SSR DOM. Hydration now descends into placeholder wrappers. (#61)
- **`@sigx/server-renderer`**: async components nested inside deferred renders (e.g. Suspense children with their own data) were silently never streamed — the replacement race loop now picks up pending work added mid-stream. (#61)
- **`@sigx/server-renderer`**: `camelToKebab('constructor')` returned `Function` through the prototype chain of a plain-object cache. (#61)
- **`sigx`**: server components' default slot dropped valid falsy children (the number `0`, `''`) — only `null`/`undefined`/booleans mean "no children" now. (#61)
- Review hardening (10 Copilot rounds on #65): prototype-pollution guards on the state blob (null-prototype target, dangerous-key rejection, own-property checks); shared keyed fetches no longer abort when their first consumer unmounts; a stale fetch settling can't evict a newer `refresh()`'s in-flight dedupe entry; `useStream` stops pulling tokens on unmount; string-mode `renderDocument` rejects on abort instead of returning truncated HTML; byte-oriented backpressure for document node streams.

### Performance

- Sync-generator render core (shared buffer + suspension protocol) replaces the per-vnode AsyncGenerator walk; component-free subtrees render through a plain recursive fast path; the sync/async double render on async pages is gone. Measured (committed baseline, i9-12900HK): string renders −9%…−45%; streaming a 10k-row table 214ms → ~41ms total with 1.7ms TTFB — fastest of sigx/Vue/React on both stream metrics. (#61)

## [0.5.0] — 2026-06-10

Foundations release for the @sigx/store redesign: real factory lifetimes in the DI layer, Topic v2 with refCount hooks and an inspection registry, working effectScope disposal, and destructuring-safe signal views. Breaking changes are called out below (0.x line).

### Added

- **`@sigx/runtime-core`**: Topic v2. `Topic<T>` now exposes `namespace`/`name` (tooling metadata), `subscriberCount`, `hasSubscribers`, and `disposed`; `createTopic` accepts `onActivate`/`onDeactivate` refCount hooks (fired on subscriberCount 0→1 and →0) so producers can pay for work only while observed. New `createTopicGroup<EventMap>({ namespace })` — a typed, lazily-created group of topics keyed by an event map. (#56)
- **`@sigx/runtime-core/inspect`** (new package entry): inspection-only topic registry for tooling — `getTopic(namespace, name)`, `listTopics(pattern?)`, `subscribeTopics(pattern, handler)` (observes existing and future matches), `onTopicCreated(handler)`. Patterns use `*` wildcards over `namespace.name`. Only topics created with a `namespace` register; `destroy()` unregisters; the registry is realm-global and deliberately `Topic<unknown>`-typed — typed app code holds `Topic<T>` references, strings are tooling metadata. (#56)
- **`@sigx/reactivity`**: `toSignal(source, key)` and `toSignals(source)` — signal-shaped live views (`{ value }`) over properties of a reactive object, so state can be destructured without losing reactivity. Reads are tracked and writes trigger through to the source. (#52)

### Changed (breaking)

- **`@sigx/runtime-core`**: `Topic.subscribe()` now throws on a destroyed topic (previously it silently re-attached a handler that could never be cleaned up), and `publish` isolates subscriber errors (a throwing handler is logged via `console.error` and no longer skips later subscribers or propagates into the publisher). `createTopic`'s `namespace`/`name` options are no longer inert. (#56)
- **`@sigx/runtime-core`**: factory lifetimes are now real. `defineFactory(setup, lifetime)` honors its lifetime argument — previously it was accepted and silently ignored, and actual behavior depended on whether `setup` declared parameters (parameterless → global singleton, with params → new instance per call). The `InstanceLifetimes` enum is replaced by the string-literal `Lifetime` type (`'singleton' | 'scoped' | 'transient'`):
  - `'singleton'` — one instance per `AppContext`, created on first resolution and disposed on `app.unmount()`. Outside any app context, falls back to one instance per JS realm.
  - `'scoped'` — the nearest instance provided via `defineProvide` in the component tree; falls back to the app-context instance when no provider exists.
  - `'transient'` — a new instance per call, auto-disposed with the calling component (or manually via `dispose()`).
  Parameterized non-transient factories honor args at first creation only ("first creation wins"). (#54)

### Fixed

- **`@sigx/runtime-core`**: singleton disposal is no longer owned by whichever component happened to resolve the instance first — previously that component's unmount disposed the shared instance while the global map kept serving the disposed corpse to later callers. App-owned instances are disposed by `app.unmount()` (via the new `AppContext.disposables`); `defineProvide`-created instances by their provider component's unmount; `app.defineProvide` instances on app unmount. (#54)
- **`@sigx/runtime-core`**: factory instances are no longer built with `{ ...result, dispose }` — the spread snapshotted accessor getters (silently breaking reactive `get foo()` returns) and dropped prototypes. `dispose` is now attached as a non-enumerable property; a setup-returned `dispose` is still delegated to, and `dispose()` is idempotent. (#54)
- **`@sigx/reactivity`**: `effectScope().stop()` now actually disposes the effects and watchers created inside `run()`. Previously the scope's cleanup list was never populated, so `stop()` silently did nothing and scoped effects kept running forever (e.g. `@sigx/store` state watchers leaked after store disposal). Nested scopes are stopped with their parent unless created detached (`effectScope(true)`). (#52)

## [0.4.9] — 2026-05-29

Restores the DOM model processor that two-way `model={…}` binding on native form elements depends on. A packaging regression had dropped it from the build, so inputs bound with `model` never received their initial `value`/`checked` — fields rendered blank even when state was populated (write-back still worked, only the initial read was lost).

### Fixed

- **`@sigx/runtime-dom`**: the platform model processor is registered in the built output again. It is installed via a side-effect-only `import './model-processor.js'` in `index.ts`, but the package's `sideEffects` field listed only `./dist/*.js` paths. The lib bundler matches `sideEffects` against *source* module ids, so without `./src/model-processor.ts` listed it tree-shook the registration away — the built `index.js` contained no `setPlatformModelProcessor` call and no `model-processor.js` chunk was emitted. As a result, native `model`-bound form elements (and every `@sigx/daisyui` component that forwards `model`) never had their initial value applied. Restored the `./src/*.ts` entries to `sideEffects` so the side-effect import survives bundling. (#34)
- **`sigx`**: restored the analogous `./src/index.ts` / `./src/jsx-runtime.ts` `sideEffects` entries on the meta-package to guard against the same class of regression. (#34)

## [0.4.8] — 2026-05-14

Follow-up to the wizard reconciler fix: a sibling bug in the same code path. Same-type patch branches were silently dropping `ref` prop changes, leaving old refs holding stale references and new refs never invoked. Also fixes an element-ref leak on unmount.

### Fixed

- **`@sigx/runtime-core`**: `patch()` now reconciles `ref` prop changes during same-type patches (both component and element branches). Previously the prop-diff loops excluded `ref`, so `<div ref={cond() ? a : b} />` or `<Child ref={whichRef()} />` would silently keep the old ref and never call the new one. The new ref now runs *after* props/slots are applied so it observes the fully-patched node. (#29)
- **`@sigx/runtime-core`**: element `unmount()` now nulls `ref.current` / calls `ref(null)`, matching the existing component-unmount behavior. Previously element refs leaked, holding stale references to removed DOM nodes. (#29)

## [0.4.7] — 2026-05-13

Fixes a renderer regression where a component's `onUnmounted` hooks silently stopped firing after any parent re-render — the second half of the sigx CLI `create` wizard bug. The previous `0.4.6` re-entrancy guard fixed one cause of the symptom; this releases the actual root cause.

### Fixed

- **`@sigx/runtime-core`**: `patch()` now copies `cleanup` from the old VNode to the new VNode in the same-type component patch branch. The `cleanup` closure is created at the end of `mountComponent` and is what `unmount()` invokes to notify plugins and run `unmountHooks`. Previously the renderer copied `_effect`, `_subTree`, `_subTreeRef`, `_slots`, and `_componentProps` but not `cleanup`, so after any parent re-render the live VNode lost its cleanup closure and the eventual unmount became a no-op. (#22)

## [0.4.6] — 2026-05-13

Fixes a re-entrant effect invocation bug that surfaced as the sigx CLI's `create` wizard rendering two steps on top of each other and refusing to finish ("folder already exists" on Enter).

### Fixed

- **`@sigx/reactivity`**: `runEffect` now guards against synchronous re-entry. When an effect's body causes the same effect to be triggered again while it is still on the call stack (e.g. a child's `onUnmounted` hook reads-then-writes the same signal during a parent's render-effect patch), the nested invocation is now ignored instead of corrupting the outer run's reactive bookkeeping. The companion `@sigx/runtime-terminal` `focus` helper that originally triggered this pattern is being hardened separately in [signalxjs/terminal](https://github.com/signalxjs/terminal); this fix is independently correct and defensive against the same pattern elsewhere.

## [0.4.5] — 2026-05-13

Fixes a hydration bug where a signal-driven component nested between two adjacent text siblings was duplicated at the end of its parent after the first reactive update.

### Fixed

- **`@sigx/server-renderer`** hydration: the `<!--t-->` text-boundary marker is now treated as a separator the cursor advances past when the next sibling is a real text node, instead of always being consumed as an empty-text placeholder. The original SSR'd DOM stays bound to its VNode, so subsequent signal updates patch in place rather than mounting fresh. (#15)
- **`@sigx/server-renderer`** hydration: when an element VNode lands on a non-element DOM cursor, hydration now forward-scans for a matching sibling and, as a last resort, creates a fresh element so `vnode.dom` is always bound — preventing later reactive patches from silently duplicating content at the end of the parent.

## [0.4.4] — 2026-05-13

Adds the runtime hook surface that `@sigx/devtools` (now in [signalxjs/devtools](https://github.com/signalxjs/devtools)) consumes. Additive and gated — no behavior change when no devtools client attaches.

### Added

- **`@sigx/reactivity`**: shared devtools hook contract installed on `globalThis.__SIGX_DEVTOOLS_HOOK__`, exported via `/internals`. New `internals` surface: `getDevtoolsHook`, `ensureDevtoolsHook`, `withoutOwnerTracking`, `getReactiveById`, plus type exports `DevtoolsHook`, `DevtoolsEventBase`, `ReactivityDevtoolsEvent`.
  - `signal()`, `computed()`, `effect()` emit creation / update / disposal events when a hook is installed.
  - `withoutOwnerTracking()` lets framework-internal reactive sub-objects (e.g. props proxies) avoid being attributed to whichever component's render effect is currently running.
- **`@sigx/runtime-core`**: re-exports the hook contract from `@sigx/reactivity/internals` and adds component-lifecycle events on top. `setCurrentInstance` mints a hook id per setup context and threads it as `instanceId` (with a `parentInstanceId` derived from `ctx.parent`). `notifyComponent*` and `handleComponentError` emit `component:created/mounted/updated/unmounted/error`. New `internals` surface: `getInstanceId`, `getParentInstanceId`, hook types.
- **`@sigx/runtime-core`** renderer: wraps the internal `signal(propsWithModels)` and `createSlots()` calls plus the prop-patch path in `withoutOwnerTracking` so child-component remounts don't leak phantom signals into the parent's reactives view.

### Internal

- `@sigx/reactivity` tsconfig target bumped to ES2021 for `WeakRef` (used by the hook's reverse id→proxy lookup).
- 14 new tests covering hook idempotency, buffering, listener errors, signal/effect/computed emissions, owner attribution, and the no-hook fast path.

## [0.4.1] — 2026-05-08

Maintenance release. No API changes.

### Internal

- `@sigx/runtime-core`, `@sigx/server-renderer`: declare `types: ["node"]` in
  tsconfig so declaration files emit cleanly under newer
  `@typescript/native-preview` releases.

## [0.4.0] — 2026-05-07

Initial public release of the SignalX (`sigx`) ecosystem on npm. Six packages published together at the same version.

### Packages

- **`sigx`** — the umbrella package most apps import from. Re-exports the public API from `@sigx/reactivity`, `@sigx/runtime-core`, and `@sigx/runtime-dom`.
- **`@sigx/reactivity`** — signals, computed, effects, `watch`, `batch`, `untrack`. Single `signal()` primitive that adapts to its input: primitives become a `.value` cell, objects become a deeply reactive Proxy you can mutate directly.
- **`@sigx/runtime-core`** — component model and renderer base shared between targets. `component`, `lazy`, `defineApp`, lifecycle (`onCreated`, `onMounted`, `onUpdated`, `onUnmounted`), DI (`injectable`), control flow (`Show`, `Switch`, `Match`), `Portal`, `Suspense`, `Fragment`, and the `Define` namespace for typed props/events/slots/models/expose.
- **`@sigx/runtime-dom`** — DOM renderer with keyed reconciliation. Signal-scoped diff: a state change only re-renders components that read the changed signals.
- **`@sigx/server-renderer`** — server-side rendering to HTML (`/server`) and matching client hydration (`/client`).
- **`@sigx/vite`** — Vite plugin for dev/build with HMR, library builds, and automatic component type generation.

### Highlights

- **One reactive primitive, two ergonomics.** `signal({...})` for direct mutation on objects/arrays; `signal(0)` for `.value`-style primitive cells.
- **TSX-first.** No template language, no SFC compiler. Set `"jsxImportSource": "@sigx/runtime-core"` in `tsconfig.json` and write components as plain TSX.
- **Two-way binding via `model={() => state.x}`** on native form elements (input/checkbox/radio/select/textarea), and on custom components via `Define.Model<T>`.
- **First-class SSR + hydration** via `@sigx/server-renderer`.
- **Tree-shakable** — packages declare `sideEffects: false` (or precise side-effect entry points where unavoidable).

### Compatibility

- Node `^20.19.0 || >=22.12.0`
- `@sigx/vite` peer-depends on `vite >=8.0.0`

[Unreleased]: https://github.com/signalxjs/core/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/signalxjs/core/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/signalxjs/core/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/signalxjs/core/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/signalxjs/core/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/signalxjs/core/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/signalxjs/core/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/signalxjs/core/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/signalxjs/core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/signalxjs/core/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/signalxjs/core/compare/v0.4.8...v0.4.9
[0.4.1]: https://github.com/signalxjs/core/releases/tag/v0.4.1
[0.4.0]: https://github.com/signalxjs/core/releases/tag/v0.4.0

