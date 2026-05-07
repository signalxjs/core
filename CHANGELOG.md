# Changelog

All notable changes to SignalX (`sigx`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While SignalX is on a `0.x` line, breaking changes may land in minor releases — they will always be called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/signalxjs/core/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/signalxjs/core/releases/tag/v0.4.0

