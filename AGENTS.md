# SignalX core — shared agent guide

Canonical guidance for **any** AI agent working in this repo (Claude Code, GitHub
Copilot CLI, work agents, …). Tool-specific notes live in `CLAUDE.md`; it defers
here for everything shared — when it conflicts with this file, the tool-specific
file wins for that tool only.

This is the sigx standard agent setup. The same pattern (this file +
`scripts/worktree.mjs` + a thin tool-specific file) is used across sigx repos —
see "Adopting this setup in another sigx repo" at the bottom.

SignalX (sigx) core is a pnpm monorepo (ESM, `"type": "module"`) of the framework
packages under `packages/`, with runnable examples under `examples/`. Tech stack:
TypeScript (strict), Vite 8, Vitest (happy-dom), oxlint. Published to npm under
the `@sigx` scope (umbrella package: `sigx`).

## Development workflow (issue → PR → Copilot review → merge)

**This is mandatory for EVERY change — including one-line fixes. Never commit
straight to `main`.** Repo: `signalxjs/core`, base branch `main`.

1. **Issue first.** If no GitHub issue already tracks the work, create one *before*
   writing code and put the plan in it:
   ```sh
   gh issue create --title "<concise title>" --body "<what & why, plus the plan/checklist>"
   ```
   If you worked in plan mode, the approved plan **is** the issue body. Note the
   number it returns (`#N`).

2. **Branch — a worktree is ideal.** Never work on `main`. Use the worktree flow
   (below): `pnpm wt new <N-short-slug>` gives an isolated checkout on branch
   `<N-short-slug>`. (Plain alternative: `git switch -c <N-short-slug>`.)

3. **Implement & verify.** Make the change, then prove it: `pnpm typecheck` (always,
   for any `.ts`) plus the relevant `pnpm test` / `pnpm build`. Stage specific
   files (`git add <path>`), never `git add -A`. No co-author trailers.

4. **Open a PR with Copilot as the reviewer.** Reference the issue so it auto-closes
   on merge:
   ```sh
   gh pr create --base main --title "<title>" \
     --body "Closes #N. <short summary of the change>" --reviewer @copilot
   ```
   (On an already-open PR: `gh pr edit <pr> --add-reviewer @copilot`.) The bot
   `copilot-pull-request-reviewer` posts its review within a minute or two. If your
   `gh` is too old to resolve `@copilot` (error: `'@copilot' not found`), request it
   via the API instead — don't skip it:
   ```sh
   gh api --method POST repos/signalxjs/core/pulls/<pr>/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```

5. **Wait for Copilot's review, then fix.** Do not merge before it has reviewed. Poll
   until a review by the bot appears, then read it:
   ```sh
   gh pr view <pr> --json reviews -q '.reviews[].author.login'   # wait for "copilot-pull-request-reviewer"
   gh pr view <pr> --json reviews,comments
   ```
   Address every actionable comment with follow-up commits and push. If the review
   doesn't re-trigger on its own, re-request it: `gh pr edit <pr> --add-reviewer @copilot`.
   Repeat until Copilot has no remaining actionable feedback.

6. **Merge it yourself.** Once Copilot's feedback is resolved AND CI is green, merge
   (merge commit, matching repo convention) and clean up:
   ```sh
   gh pr checks <pr>                          # must be all green first
   gh pr merge <pr> --merge --delete-branch
   ```
   If you used a worktree, remove it afterward: `pnpm wt rm <name>`.

## Build, Test, Lint

```bash
pnpm install
pnpm build       # all packages: core + server-renderer + vite plugin
pnpm build:core  # reactivity + runtime-core + runtime-dom + sigx
pnpm test        # vitest run (unit tests across packages)
pnpm test -- packages/reactivity   # single test file/dir (substring match)
pnpm test -- -t "name of test"     # single test by name (vitest -t)
pnpm test:watch
pnpm test:coverage
pnpm typecheck   # tsgo (a fast TS compiler), config: tsconfig.json
pnpm lint        # oxlint over the core packages' src
pnpm lint:fix
pnpm size        # size-limit bundle-size check (.size-limit.json)
pnpm verify:pack # verify npm pack output is sane
pnpm dev:sigx    # watch-build the sigx package
pnpm dev:vite    # watch-build the vite plugin
```

To run an example app: `pnpm --filter <example-package-name> dev` (Vite picks a
free port automatically).

## Packages

- `packages/reactivity` → `@sigx/reactivity` — signals, computed, effects.
- `packages/runtime-core` → `@sigx/runtime-core` — component model, renderer base.
- `packages/runtime-dom` → `@sigx/runtime-dom` — DOM renderer.
- `packages/sigx` → `sigx` — umbrella public package.
- `packages/server-renderer` → `@sigx/server-renderer` — SSR + hydration.
- `packages/vite` → `@sigx/vite` — Vite plugin for dev/build/HMR.
- `examples/` — runnable apps (`hello`, `spa`, `spa-ssr`).

Path aliases: `tsconfig.json` and `vitest.config.ts` map `@sigx/*` and `sigx` to
`packages/*/src`, so tests and typecheck run against source, not dist.

## Parallel work with git worktrees

To work two things at once — each with its own checkout and its own agent
session — use a worktree instead of switching branches in place:

```sh
pnpm wt new <name> [--from <branch>]   # worktree at ../<name>: own branch + deps installed
pnpm wt list                           # show all worktrees
pnpm wt rm <name> [--force]            # remove a worktree
```

`pnpm wt new` creates a sibling checkout of the main one on a new branch `<name>`
and runs `pnpm install` (pnpm hardlinks from the global store — fast). Launch a
**separate agent session from the worktree directory**; sessions stay independent
per directory. Names: letters, digits, `.`, `_`, `-` only.

## Conventions & working principles

- **Plan first for non-trivial work.** Both Claude Code and Copilot CLI have a built-in plan mode; use it and let the CLI manage the plan file.
- **Verify before declaring done.** Run typecheck/tests for code changes; show evidence the change works.
- **Minimal, surgical edits.** Don't refactor unrelated code. Don't add backward-compat shims for things that never shipped.
- **Windows paths**: This repo is checked out on Windows — use backslashes when invoking shell commands directly.
- **Git hygiene**: Stage specific files (`git add <path>`), never `git add -A` / `git add .`. Run `pnpm typecheck` before any commit touching `.ts`. Do **not** add co-author trailers to commits (e.g. `Co-Authored-By: Claude …` / `Co-authored-by: Copilot …`).

## Adopting this setup in another sigx repo

This file, `scripts/worktree.mjs`, and `CLAUDE.md` are the portable sigx
standard. To adopt it in another repo:

1. Copy `scripts/worktree.mjs` and `CLAUDE.md` verbatim; copy this `AGENTS.md` as a template.
2. Add `"wt": "node scripts/worktree.mjs"` to the repo's `package.json` scripts.
3. Adapt the repo-specific sections of `AGENTS.md`: the intro (what the repo is),
   "Build, Test, Lint", and "Packages". In the workflow section, swap the repo
   slug (`signalxjs/core`) in the `gh api` fallback.
4. Keep the workflow, worktree, and conventions sections as-is — they are the
   shared standard.
