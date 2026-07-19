# Maintainers Guide

One-time setup steps for the SignalX repo. Once configured, the GitHub Actions
workflows in `.github/workflows/` handle the rest.

## Required GitHub secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret           | Used by                  | How to obtain                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `CODECOV_TOKEN`  | `ci.yml` (coverage job)  | codecov.io → link the repo → copy the upload token from the repo settings page. Required because `main` is a protected branch — Codecov rejects tokenless uploads on protected branches even when the org auth setting is "Not required". |
| `ECOSYSTEM_DISPATCH_TOKEN` | `release.yml` (`notify-consumers` job) | A fine-grained PAT (or GitHub App token) that can send a `repository_dispatch` to every consumer repo. See "Notifying consumer repos" below. **Optional** — if unset, the job skips cleanly (consumers still catch releases via their weekly cron). |

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed. `release.yml`
publishes via npm trusted publishing (OIDC), so no `NPM_TOKEN` is required.

## npm trusted publishing

Each of the six packages on npmjs.com is configured to trust this repo's
`release.yml` workflow. Configuration: package page → Settings → Trusted
Publishers → GitHub Actions, with:

- Owner: `signalxjs`
- Repository: `core`
- Workflow filename: `release.yml`
- Environment: blank

`scripts/publish.js` still accepts an `NPM_TOKEN` env var as a fallback for
local publishes (e.g. emergency manual release from a laptop) but CI never
uses it.

### Version requirements

Per https://docs.npmjs.com/trusted-publishers, the OIDC token exchange
requires **npm CLI ≥ 11.5.1** and **Node ≥ 22.14.0**. `release.yml` uses
Node 24 (which ships npm 11.x) and explicitly runs `npm install -g npm@latest`
before the publish step. If you downgrade either, registry PUTs will fail
silently — see "diagnosing publish failures" below.

### Two-job structure

`release.yml` splits into two jobs:

1. **`publish-npm`** — `permissions: { id-token: write, contents: read }`.
   Runs lint/typecheck/build/test/verify:pack, then `node scripts/publish.js`.
   Holds the OIDC claim, no write access to the repo.
2. **`github-release`** — `needs: publish-npm`, `permissions: { contents: write }`.
   Creates/finalizes the GitHub Release. No OIDC claim.
3. **`notify-consumers`** — `needs: publish-npm`, tag-only, `permissions: {}`.
   Fans a `core-released` dispatch out to the consumer repos (see "Notifying
   consumer repos" below). Additive and failure-swallowing; never blocks a release.

This keeps the OIDC-claim job from also having write access to the repo,
and ensures the GitHub Release is never published if the npm publish fails
(the previous single-job version did publish a misleading "v0.4.1 latest"
GH release while every npm PUT failed).

### Diagnosing publish failures

| Symptom in `Publish to npm` step | What it actually means |
| --- | --- |
| `404 Not Found - PUT https://registry.npmjs.org/<pkg>` | OIDC claim was rejected. Either npm is too old (< 11.5.1, see above), the trusted-publisher config on npmjs.com doesn't match (workflow filename, owner, repo, environment), or no trusted publisher is registered for that package. The 404 is npm's deliberate ambiguity — it does NOT mean the package is missing. |
| `Provenance statement published to transparency log` followed by 404 | Same as above. Provenance signing succeeds via sigstore (different code path that accepts the raw OIDC token), so a successful provenance line doesn't mean the publish itself succeeded. |
| Job step shows ✅ but `npm view <pkg> version` is unchanged | `scripts/publish.js` previously had a bug where partial failures didn't propagate as a non-zero exit code. Fixed in 14dc29e. If you ever see this again, check the bottom of the publish script for the `process.exitCode = 1` guard. |
| Trusted-publisher card on npmjs.com looks correct but still 404 | Verify all six packages — the publish script stops at the first failure, so a misconfigured later-in-the-list package wouldn't surface until the earlier ones are fixed. Order: `@sigx/reactivity`, `@sigx/runtime-core`, `@sigx/runtime-dom`, `sigx`, `@sigx/server-renderer`, `@sigx/vite`. |

## Notifying consumer repos

The ecosystem repos (`router`, `store`, `use`, `lynx`, `ssg`, `pulse`) pin core
packages to a single minor through the `catalog:` block of their
`pnpm-workspace.yaml`, and each ships a `core-sync.yml` workflow that — on a
`core-released` `repository_dispatch` — opens a "chore: align with core X.Y" PR
(bumping the catalog, then building/testing before it proposes the bump). That
consumer-side machinery lives in
[`signalxjs/repo-template`](https://github.com/signalxjs/repo-template).

`release.yml`'s **`notify-consumers`** job closes the loop: after a successful
publish on a tag, it fans a `core-released` event (carrying the released version)
out to each consumer, so alignment PRs appear within minutes. It is additive by
design — `needs: publish-npm`, tag-only, and it swallows per-repo dispatch
failures — so it can never affect the npm publish or the GitHub release.

The default `GITHUB_TOKEN` **cannot** dispatch to other repos, so the job
authenticates with an **`ECOSYSTEM_DISPATCH_TOKEN`** secret. To activate the loop:

1. Create a **fine-grained PAT** (or a GitHub App installation token) with
   **`repository_dispatch: write`** (Actions → Repository dispatch) on each
   consumer repo — `router`, `store`, `use`, `lynx`, `ssg`, `pulse`. No other
   scopes are needed.
2. Store it as the `ECOSYSTEM_DISPATCH_TOKEN` Actions secret **in this (core)
   repo**: `gh secret set ECOSYSTEM_DISPATCH_TOKEN -R signalxjs/core`.
3. Confirm each consumer has `core-sync.yml` on its default branch (shipped by the
   template) and appears in the job's fan-out loop in `release.yml`.

If the secret is absent, `notify-consumers` logs that it's skipping and exits 0 —
consumers still pick up the release on `core-sync.yml`'s weekly cron. Remember to
extend the fan-out loop when a new consumer repo joins the ecosystem.

## Branch protection (`main`)

Settings → Rules → Rulesets → New branch ruleset:

- **Target**: `main`
- **Restrict deletions**: ✅
- **Block force pushes**: ✅
- **Require linear history**: ✅
- **Require a pull request before merging**: ✅
  - Required approvals: `0` (solo maintainer; CI still gates the merge)
  - Dismiss stale approvals on new commits: ✅
- **Require status checks to pass before merging**: ✅
  - `test (ubuntu-latest, 20)`
  - `test (ubuntu-latest, 22)`
  - `test (windows-latest, 22)`
  - `verify-pack`
  - `coverage`
  - `size`
- **Require signed commits**: optional, recommended

## Releasing

1. Bump versions: `node scripts/bump-version.js patch` (or `minor` / `major`,
   or an exact version like `0.5.0`). Skip `pnpm version:patch` — pnpm v11's
   pre-run deps-status check fails interactively here.
2. Update `CHANGELOG.md` — move `Unreleased` content under a new heading
   `## [X.Y.Z] — YYYY-MM-DD`, add the `[X.Y.Z]: …/releases/tag/vX.Y.Z` link,
   update the `[Unreleased]` compare URL.
3. Refresh the lockfile: `pnpm install --lockfile-only` (regenerates
   `pnpm-lock.yaml` so `pnpm install --frozen-lockfile` in CI passes).
4. Local sanity: `pnpm build && pnpm verify:pack` — catches packaging bugs
   (missing files, broken `exports`, unresolved `workspace:^`) before the
   tag exists. The CI's `verify-pack` job re-runs this, but a tag is harder
   to undo than a commit.
5. Commit: `git commit -am "chore: release vX.Y.Z"`.
6. Tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags`.
7. `release.yml` takes over — see the two-job structure above. End state:
   all six packages live at `vX.Y.Z` on npm with provenance, GitHub Release
   marked latest.

### If something fails mid-release

- **Nothing published yet** (failure during `publish-npm` before any package
  succeeds): delete the tag locally and remotely
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), delete the GH
  release if one was created (`gh release delete vX.Y.Z`), fix the issue,
  re-tag.
- **Some packages published, others didn't**: do NOT delete the tag.
  npm versions are immutable. Bump to the next patch (e.g. 0.4.2) so the
  failed packages can publish at the new version while the succeeded
  packages move forward too.

### Prereleases

Use a prerelease version (e.g. `0.5.0-rc.0`) and push the matching tag.
The publish script does not pass `--tag` automatically; add `--tag beta`
(or similar) to `release.yml`'s publish step if a non-`latest` dist-tag is
needed.

## What runs when

| Trigger                              | Workflow(s)                                            |
| ------------------------------------ | ------------------------------------------------------ |
| PR opened / updated                  | `ci.yml` (test matrix, verify-pack, coverage), `bundle-size.yml`, `release-drafter.yml`, `dependabot-automerge.yml` (if dependabot) |
| Push to `main`                       | `ci.yml`, `release-drafter.yml`                         |
| Push tag `v*.*.*`                    | `release.yml`                                           |
