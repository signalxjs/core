# Contributing to SignalX

Thanks for your interest in SignalX! This repo is the **core** of the framework — reactivity, runtime, DOM renderer, SSR, and the Vite plugin. Higher-level pieces (router, store, UI kit, terminal/3D renderers, SSG, scaffolding CLI, docs site) live in their own repositories under [`signalxjs`](https://github.com/signalxjs).

## Prerequisites

- **Node.js** `^20.19.0` or `>=22.12.0`
- **pnpm** `>=10` (this repo uses workspaces; `npm` and `yarn` are not supported)

## Getting started

```bash
git clone https://github.com/signalxjs/core.git
cd core
pnpm install
pnpm build
```

The `build` step is required before tests because some packages consume each other's `dist/` output through the workspace.

## Workspace layout

Six packages live under `packages/`. See the table in the root `README.md` for what each one does.

```
packages/
  reactivity/      → @sigx/reactivity     (signals, computed, effects)
  runtime-core/    → @sigx/runtime-core   (component model, renderer base)
  runtime-dom/     → @sigx/runtime-dom    (DOM renderer)
  sigx/            → sigx                 (umbrella package)
  server-renderer/ → @sigx/server-renderer (SSR + hydration)
  vite/            → @sigx/vite           (Vite plugin)
```

## Common tasks

| Task | Command |
|---|---|
| Build all packages | `pnpm build` |
| Run all tests | `pnpm test` |
| Run tests in watch mode | `pnpm test:watch` |
| Lint | `pnpm lint` |
| Try a runnable example | `pnpm --filter @sigx/spa-example dev` |

## Pre-push checklist

Before opening a PR, run:

```bash
pnpm lint
pnpm test
pnpm build
```

## Pull request guidelines

- **Keep PRs small and focused.** One logical change per PR.
- **Reference an issue** if one exists; otherwise describe the motivation in the PR body.
- **Add tests** for new behaviour or bug fixes. Tests live in `packages/<name>/__tests__/`.
- **Update `CHANGELOG.md`** under the `[Unreleased]` section.
- **Don't bump versions** in your PR — release versioning is handled centrally via the `pnpm version:*` scripts.

## Reporting bugs and requesting features

- **Bug?** Open an issue with the [bug report template](https://github.com/signalxjs/core/issues/new?template=bug_report.yml). A minimal reproduction (StackBlitz or a small repo) helps a lot.
- **Feature idea?** Use the [feature request template](https://github.com/signalxjs/core/issues/new?template=feature_request.yml). API sketches welcome.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be kind.

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
