# Changelog

All notable changes to SignalX (`sigx`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While SignalX is on a `0.x` line, breaking changes may land in minor releases — they will always be called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/signalxjs/core/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/signalxjs/core/releases/tag/v0.4.1
[0.4.0]: https://github.com/signalxjs/core/releases/tag/v0.4.0

