# Changelog

All notable changes to SignalX (`sigx`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While SignalX is on a `0.x` line, breaking changes may land in minor releases — they will always be called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/signalxjs/core/compare/v0.4.9...HEAD
[0.4.9]: https://github.com/signalxjs/core/compare/v0.4.8...v0.4.9
[0.4.1]: https://github.com/signalxjs/core/releases/tag/v0.4.1
[0.4.0]: https://github.com/signalxjs/core/releases/tag/v0.4.0

