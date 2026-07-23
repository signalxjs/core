# SignalX core — shared agent guide

> ⚠️ **BRANCH FIRST — never work on `main`.** Before touching ANY file, create a
> worktree (`pnpm wt new <N-short-slug>`) and do everything from
> `<repo>/branches/<N-short-slug>`. This applies to every change, however small —
> editing or committing in the primary checkout (`<repo>/main`) causes conflicts
> for parallel sessions. Check yourself before every commit:
> `git branch --show-current` must print your worktree's branch name — if it
> prints `main` or nothing (detached HEAD), stop.
> Already edited files in `main` by mistake? Move the work, don't commit it:
> `git stash -u` → `pnpm wt new <N-short-slug>` →
> `cd <repo>/branches/<N-short-slug>` → `git stash pop`.

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

**This is mandatory for EVERY agent-driven change — including one-line fixes.
Never commit straight to `main`.** Repo: `signalxjs/core`, base branch `main`.
(Human contributors follow `CONTRIBUTING.md`, where an issue is optional; for
agents the issue-first flow below is required.)

1. **Issue first.** If no GitHub issue already tracks the work, create one *before*
   writing code and put the plan in it:
   ```sh
   gh issue create --title "<concise title>" --body "<what & why, plus the plan/checklist>"
   ```
   If you worked in plan mode, the approved plan **is** the issue body. Note the
   number it returns (`#N`).

2. **Worktree, always.** Never work on `main`. Use the worktree flow (below):
   `pnpm wt new <N-short-slug>` gives an isolated checkout on branch
   `<N-short-slug>`. Don't substitute `git switch -c` in the primary checkout —
   it occupies `<repo>/main`, which parallel sessions share.

3. **Implement & verify.** Make the change, then prove it: `pnpm typecheck` (always,
   for any `.ts`) plus the relevant `pnpm test` / `pnpm build`. Stage specific
   files (`git add <path>`), never `git add -A`. No co-author trailers.

4. **Open a PR with Copilot as the reviewer.** Reference the issue so it auto-closes
   on merge:
   ```sh
   gh pr create --base main --title "<title>" \
     --body "Closes #N. <short summary of the change>" --reviewer @copilot
   ```
   The PR description becomes the squash commit **body** verbatim, and the PR
   title (with ` (#<pr>)` appended) becomes its subject — see step 6. Write the
   description as the commit body you want on `main`.
   (On an already-open PR: `gh pr edit <pr> --add-reviewer @copilot`.) The bot
   `copilot-pull-request-reviewer` posts its review within a minute or two. If your
   `gh` is too old to resolve `@copilot` (error: `'@copilot' not found`), request it
   via the API instead — don't skip it:
   ```sh
   gh api --method POST repos/signalxjs/core/pulls/<pr>/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```
   (The reviewer-request API takes the `[bot]`-suffixed slug; the review author
   login in `.reviews[].author.login` appears *without* the suffix.)

5. **Wait for Copilot's review, then fix.** Do not merge before it has reviewed. Poll
   until a review by the bot appears, then read it:
   ```sh
   gh pr view <pr> --json reviews -q '.reviews[].author.login'   # wait for "copilot-pull-request-reviewer"
   gh pr view <pr> --json reviews,comments
   ```
   Address every actionable comment with follow-up commits and push. If the review
   doesn't re-trigger on its own, re-request it: `gh pr edit <pr> --add-reviewer @copilot`.
   Repeat until Copilot has no remaining actionable feedback.

   **Then resolve the threads — this is a merge requirement, not politeness.**
   `main`'s ruleset sets `required_review_thread_resolution`, so a PR carrying
   an unresolved **inline** comment cannot merge no matter how green it is.
   Pushing the fix does not resolve a thread, and neither does replying at PR
   level. There is no `gh pr` porcelain for it — reply on each thread and
   resolve it over GraphQL:
   ```sh
   # list the open threads
   gh api graphql -f query='query { repository(owner:"signalxjs", name:"core") {
     pullRequest(number:<pr>) { reviewThreads(first:100) { nodes {
       id isResolved comments(first:1){nodes{body}} } } } } }' \
     -q '.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved==false) | "\(.id) \(.comments.nodes[0].body[0:60])"'

   # reply (say which commit fixed it), then resolve — pass the body as a
   # GraphQL variable, not string-interpolated: quotes and backslashes in a
   # review reply otherwise break the query
   gh api graphql -f query='mutation($t:ID!,$b:String!){
     addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment { id } } }' \
     -f t="<thread-id>" -f b="Fixed in <sha>. <what changed>"
   gh api graphql -f query='mutation($t:ID!){
     resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -f t="<thread-id>"
   ```

6. **Queue the merge yourself.** Once Copilot's feedback is resolved, CI is
   green, and — for user-facing changes — the docs issue is filed on the docs
   repo and linked from the PR (see "Documentation"), add the PR to `main`'s
   **merge queue** (squash — repo rules block merge commits) and clean up:
   ```sh
   pr=123                                     # your PR number (digits only)
   gh pr checks "$pr"                         # must be all green first
   gh pr merge "$pr" --squash --auto          # NOT --delete-branch: rejected
                                              # outright when a queue is enabled
                                              # ("Cannot use `-d` or
                                              # `--delete-branch` when merge
                                              # queue enabled"). The queue
                                              # deletes the branch itself.
   ```
   Then confirm it actually entered the queue — armed auto-merge is not the
   same as queued:
   ```sh
   gh api graphql -f query='query { repository(owner:"signalxjs", name:"core") {
     pullRequest(number:'"$pr"') {
       mergeStateStatus mergeQueueEntry { state position } } } }'
   ```
   `mergeQueueEntry: null` with `mergeStateStatus: BLOCKED` and every check
   green means something the checks don't show is blocking — in practice an
   unresolved review thread (step 5). Nothing will happen until you clear it;
   the PR just sits there.

   The queue serializes concurrent sessions' merges: it updates the PR
   against the latest `main`, re-runs the required checks on the merge-group
   ref (ci.yml's `merge_group` trigger — never remove it, queued PRs would
   wait forever), and merges in order. Do NOT race `main` with a plain
   `gh pr merge` or manual `update-branch` loops. The squash message comes
   from the repo's defaults (PR title + PR body) — **write the PR title and
   body as the commit subject/body you want on `main`**; explicit
   `--subject`/`--body` does not apply to queue merges. GitHub may append
   `Co-authored-by:` trailers to queue-generated messages — accepted as the
   price of serialized merges. If you used a worktree, remove it afterward:
   `pnpm wt rm <name>`.

## Build, Test, Lint

```bash
pnpm install
pnpm build       # all packages: core + server-renderer + vite plugin
                 # each package builds twice: dist/*.js (dev) + dist/*.prod.js
                 # (NODE_ENV-stripped), selected via export conditions
pnpm build:core  # reactivity + runtime-core + runtime-dom + sigx
pnpm test        # vitest run (unit tests across packages)
pnpm test -- packages/reactivity   # single test file/dir (substring match)
pnpm test -- -t "name of test"     # single test by name (vitest -t)
pnpm test:watch
pnpm test:coverage
pnpm typecheck   # tsc (TypeScript 7 native compiler), config: tsconfig.json
pnpm lint        # oxlint over all packages' src (warnings fail: --deny-warnings)
pnpm lint:fix
pnpm size        # size-limit bundle-size check (.size-limit.mjs)
pnpm verify:pack # verify npm pack output is sane
pnpm test:edge   # WinterCG smoke: stream a document from the prod dist with node: imports forbidden (after pnpm build)
pnpm smoke:hydration   # did the prod build actually HYDRATE, or silently re-render client-side? (after pnpm build)
                       # Builds examples/spa-ssr + examples/ssr-islands, serves them, and drives Chromium:
                       # every <!--$c:N--> marker the server sent must still be in the live DOM (a bail's
                       # removeSSRRange takes nested markers with it). Both mismatch warnings are __DEV__-gated,
                       # so this is the ONLY hydration signal a prod dist has (#377). Needs a browser:
                       # `pnpm exec playwright install chromium` once. CI job: hydration-smoke.
pnpm bench:ssr:quick   # sigx-only quick SSR bench + regression table vs the committed baseline (after pnpm build)
pnpm bench:ssr         # full comparative SSR bench: equivalence check, then sigx vs Vue/React/Preact
                       # CI runs `verify` + the quick suite (bench-smoke job) as a CORRECTNESS gate: it catches
                       # adapter rot and output divergence, never timing (CI logs the delta table without
                       # --enforce, so its slower-hardware numbers are informational). Enforce locally with
                       # `pnpm --filter @sigx/benchmarks bench:quick:enforce`, and re-baseline on YOUR machine
                       # with `pnpm bench:ssr:baseline` (check-regression refuses to enforce across machines).
                       # Every bench script runs node --conditions production: sigx picks its dev/prod dist at
                       # module resolution, so a bare `node` measures the dev build (see benchmarks/README.md).
pnpm dev:sigx    # watch-build the sigx package
pnpm dev:vite    # watch-build the vite plugin
```

To run an example app: `pnpm --filter <example-package-name> dev` (Vite picks a
free port automatically).

## Packages

- `packages/reactivity` → `@sigx/reactivity` — signals, computed, effects.
- `packages/serialize` → `@sigx/serialize` — the boundary codec: how `Date`,
  `Map`, `Set`, `BigInt` and custom types survive every server↔client
  boundary (SSR state blob, resume boundary props, cache seed, server-fn RPC
  wire). Both halves run on both sides — encode on the server for the state
  blob and on the client for RPC arguments, revive the mirror. **Zero
  dependencies, permanently**: `@sigx/server/client` imports it, and that
  entry is the size-limited "stubs import nothing" guard, so anything added
  here lands in chunks resume replicates. The per-app handler registry
  (`provideTypeHandlers`) lives in `@sigx/runtime-core` instead, since it
  needs `createToken` — this package stays a pure pair of functions.
- `packages/runtime-core` → `@sigx/runtime-core` — component model, renderer base.
- `packages/runtime-dom` → `@sigx/runtime-dom` — DOM renderer.
- `packages/sigx` → `sigx` — umbrella public package.
- `packages/server-renderer` → `@sigx/server-renderer` — SSR + hydration. A
  strategy-agnostic plugin platform; hydration strategies are plugins, not core.
- `packages/ssr-islands` → `@sigx/ssr-islands` — islands architecture (selective
  hydration via `client:*` directives). The first-party *reference* strategy pack
  riding `@sigx/server-renderer`'s public plugin API; a drop-in equal of any
  third-party pack, with no privileged access to core. Installed via
  `app.use(islandsPlugin())` in the entry-server's app factory (#413 — one
  install shape; the server hooks ride the `provideSSRPlugin` seam). Its
  runnable example app lives at `examples/ssr-islands/` (private workspace
  package).
- `packages/resume` → `@sigx/resume` — resumability (QRL event
  handlers via `data-sigx-on:*` attributes, zero-JS pages, upgrade-on-write
  hydration). The second first-party strategy pack riding
  `@sigx/server-renderer`'s public plugin API — a drop-in equal of any
  third-party pack, no privileged access to core. Installed via
  `app.use(resumePlugin())` in the entry-server's app factory (#413). Its
  Vite transform lives at `@sigx/vite/resume`.
- `packages/cache` → `@sigx/cache` — cache policy for value-first async
  (staleTime/gcTime, revalidation, `invalidate()`, optimistic `mutate()`). The
  first-party pack on the rfc-async §7 engine seam — a drop-in equal of any
  third-party pack, no privileged access to core.
- `packages/server` → `@sigx/server` — server functions (RPC): `serverFn` in
  `*.server.ts` modules, extracted to typed fetch stubs by `@sigx/vite/server`;
  WinterCG endpoint (`./server`) + Node adapter (`./node`) with security
  defaults (rfc-server, #302); app-plugin face (`./plugin`):
  `app.use(serverPlugin({ transport, types }))` for client-side config, with
  `types` registering custom type handlers once for both the RPC wire and
  the state/boundary registry (#413, #411). NOT `@sigx/server-renderer`
  (that renders documents; this is how the app talks to the server).
  Platform adapters (cloudflare/deno/bun) would be separate top-level
  packages — `./node` is interface bridging, not platform integration.
  Rides public seams only.
- `packages/vite` → `@sigx/vite` — Vite plugin for dev/build/HMR.
- `packages/cloudflare` → `@sigx/cloudflare` — Cloudflare Workers deployment
  adapter (rfc-deploy §4.2): `cloudflare()` rides `@sigx/vite`'s public
  `SigxAdapter` seam — fully bundled workerd-conditioned server build,
  scaffold-iff-absent `entry.cloudflare.ts` + `wrangler.jsonc`, `devProxy`
  binding proxies via wrangler's `getPlatformProxy`. Build-time-only Node
  code: no size-limit entry (deliberate). The first platform adapter pack;
  Deno/Bun stay docs + copyable entries (`examples/resume`).
- `packages/vercel` → `@sigx/vercel` — Vercel deployment adapter (rfc-deploy
  §4.4): `vercel()` generates the full Build Output API v3 layout
  (`.vercel/output`: `static/`, `functions/_render.func`, `config.json`
  routes) — a generation contract, regenerated every build, unlike the
  scaffold-once wrangler posture. Structural verification only (layout +
  direct fetch invocation under Node); no emulation. Build-time-only Node
  code: no size-limit entry.
- `packages/netlify` → `@sigx/netlify` — Netlify deployment adapter
  (rfc-deploy §4.5, the last platform phase): `netlify()` emits the
  Frameworks API channel (`.netlify/v1/functions/sigx-ssr` — a generated
  Functions-v2 wrapper with `path: '/*'` + `preferStatic` over the bundled
  server); publish dir = the client outDir (its raw `index.html` removed);
  `netlify.toml` printed, never written. Same structural-verification
  posture as vercel. Build-time-only Node code: no size-limit entry.
- `examples/` — runnable apps (`hello`, `spa`, `spa-ssr`, `ssr-islands`,
  `resume`, `storefront` — the resumability showcase).

Path aliases: `tsconfig.json` and `vitest.config.ts` map `@sigx/*` and `sigx` to
`packages/*/src`, so tests and typecheck run against source, not dist.

## Parallel work with git worktrees

To work two things at once — each with its own checkout and its own agent
session — use a worktree instead of switching branches in place:

```sh
pnpm wt new <name> [--from <branch>]   # worktree at <repo>/branches/<name>: own branch + deps installed
pnpm wt list                           # show all worktrees
pnpm wt rm <name> [--force]            # remove a worktree
```

Layout convention (all sigx repos): the primary checkout lives at `<repo>/main`
and every worktree at `<repo>/branches/<name>`. `pnpm wt new` creates the
checkout there on a new branch `<name>` and runs `pnpm install` (pnpm hardlinks
from the global store — fast). Launch a **separate agent session from the
worktree directory**; sessions stay independent per directory. Names: letters,
digits, `.`, `_`, `-` only.

## Documentation

Docs are part of the change, not a follow-up — in-repo docs ship in the same
PR, and the docs-site update is queued (as a docs-repo issue) before merge. Two
surfaces, two rules:

**In-repo docs — update in *this* PR when you touch the matching thing:**

| When you… | Update… |
|---|---|
| add / rename / remove a package | `AGENTS.md` "Packages" and the README package table — plus, **whichever of these the repo has**: `CONTRIBUTING.md` layout, the issue-template package dropdowns, `.size-limit.mjs`, and the `tsconfig` / `vitest` path aliases |
| change a build / test / lint script | `AGENTS.md` "Build, Test, Lint", `CONTRIBUTING.md` "Common tasks", `package.json` |
| change or add public API / behaviour | the package's own `README.md` and `CHANGELOG.md` under `[Unreleased]` |
| add / change a `globalThis.__SIGX_*` seam | `docs/seams.md` — the registry of every cross-package global: name, direction, writer, reader, contract. A global with no entry there is a bug; the map used to exist only by grepping, and a read site got missed because of it |
| change the workflow / process itself | `AGENTS.md` here — and, since it is the shared standard, upstream the same change to [`signalxjs/repo-template`](https://github.com/signalxjs/repo-template) |

**The docs *site* is separate — don't edit it from here.** User-facing changes
(new or changed public API, features, packages) must end up documented on the
docs site [`signalxjs/signalxjs.github.io`](https://github.com/signalxjs/signalxjs.github.io),
but that work belongs to the **docs agent**, which works through the docs repo's
issue queue. Don't open docs-site PRs from source repos — your job is to feed
the queue, in two moments:

- **Before merging a PR with user-facing changes, file an issue on the docs
  repo** describing what changed and what the docs need to cover, and link it
  from the PR:
  ```sh
  gh issue create --repo signalxjs/signalxjs.github.io \
    --title "core: <what changed>" \
    --body "Source: signalxjs/core#<pr>. <What needs documenting, and where on the site.> Not yet released."
  ```
  A user-facing PR isn't mergeable until its docs issue exists (see step 6 of
  the workflow).
- **When you cut a release** (push a `vX.Y.Z` tag), comment the release tag on
  every open docs issue covering a change shipped in that release:
  ```sh
  gh issue comment <n> --repo signalxjs/signalxjs.github.io \
    --body "Released in core vX.Y.Z."
  ```
  (Mention the published package version(s) too if they differ from the tag.)
  A docs issue without a release comment means *merged but not released — don't
  document yet*; the release comment is the docs agent's signal that the change
  is live and ready to document.

## Conventions & working principles

- **Plan first for non-trivial work.** Both Claude Code and Copilot CLI have a built-in plan mode; use it and let the CLI manage the plan file.
- **Verify before declaring done.** Run typecheck/tests for code changes; show evidence the change works.
- **Dev-only code goes behind `__DEV__`.** Warnings, validation, devtools
  plumbing: guard with `if (__DEV__)` (not literal `process.env.NODE_ENV`
  checks). It's a compile-time flag — `false` in the prod dist (blocks are
  stripped), the runtime NODE_ENV check in the dev dist — defined by
  `defineLibConfig` (package builds) and `vitest.config.ts` (tests); ambient
  type in each package's `src/env.d.ts`.
- **Minimal, surgical edits.** Don't refactor unrelated code. Don't add backward-compat shims for things that never shipped.
- **Cross-platform paths**: Contributors and CI run on Windows, macOS and Linux — use the path separator and shell syntax of the environment you're in, and prefer Node scripts over shell one-liners for anything committed to the repo.
- **Git hygiene**: Stage specific files (`git add <path>`), never `git add -A` / `git add .`. Run `pnpm typecheck` before any commit touching `.ts`. Do **not** add co-author trailers to commits (e.g. `Co-Authored-By: Claude …` / `Co-authored-by: Copilot …`).

## Adopting this setup in another sigx repo

This file, `scripts/worktree.mjs`, and `CLAUDE.md` are the portable sigx
standard. To adopt it in another repo:

1. Check the repo out using the standard layout: primary checkout at
   `<repo>/main`, worktrees under `<repo>/branches/`.
2. Copy `scripts/worktree.mjs` and `CLAUDE.md` verbatim; copy this `AGENTS.md` as a template.
3. Add `"wt": "node scripts/worktree.mjs"` to the repo's `package.json` scripts.
4. Adapt the repo-specific sections of `AGENTS.md`: the intro (what the repo is),
   "Build, Test, Lint", and "Packages". In the workflow section, swap the repo
   slug (`signalxjs/core`) in the `gh api` fallback.
5. Keep the workflow, worktree, and conventions sections as-is — they are the
   shared standard.
