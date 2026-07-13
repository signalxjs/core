# Changelog

All notable changes to SignalX (`sigx`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While SignalX is on a `0.x` line, breaking changes may land in minor releases — they will always be called out here.

## [Unreleased]

### Fixed

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

[Unreleased]: https://github.com/signalxjs/core/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/signalxjs/core/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/signalxjs/core/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/signalxjs/core/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/signalxjs/core/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/signalxjs/core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/signalxjs/core/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/signalxjs/core/compare/v0.4.8...v0.4.9
[0.4.1]: https://github.com/signalxjs/core/releases/tag/v0.4.1
[0.4.0]: https://github.com/signalxjs/core/releases/tag/v0.4.0

