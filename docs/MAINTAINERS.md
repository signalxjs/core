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

Every published package on npmjs.com is configured to trust this repo's
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
| Trusted-publisher card on npmjs.com looks correct but still 404 | Verify **every** package — the publish script stops at the first failure, so a misconfigured later-in-the-list package wouldn't surface until the earlier ones are fixed. The authoritative list and order is the `PACKAGES` array in `scripts/publish.js` (dependency order, `@sigx/serialize` first). |

## Notifying consumer repos

**The consumer list lives in [`docs/ecosystem.json`](ecosystem.json)** — the ecosystem
manifest. It records, per repo, which core packages it pins, which *sibling* packages
it consumes, and the release **tier** those dependencies imply. `release.yml` reads it
for the fan-out, [`docs/ecosystem-release.md`](ecosystem-release.md) reads it for the
release order, and `scripts/check-ecosystem.mjs` (`pnpm verify:ecosystem`, a CI step)
gates it on every run: a new core package, a mis-ordered tier or an unresolvable
sibling fails the build. **Never hardcode a consumer list anywhere** — the literal loop
this replaced had drifted to six of the twelve live consumers.

Each consumer pins core packages to a single minor through the `catalog:` block of its
`pnpm-workspace.yaml` and ships a `core-sync.yml` workflow that — on a
`core-released` `repository_dispatch` — opens a "chore: align with core X.Y" PR
(bumping the catalog, then building/testing before it proposes the bump). That
consumer-side machinery lives in
[`signalxjs/repo-template`](https://github.com/signalxjs/repo-template).

`release.yml`'s **`notify-consumers`** job closes the loop: after a successful
publish on a tag, it fans a `core-released` event (carrying the released version)
out to each consumer, so alignment PRs appear within minutes. It is additive by
design — `needs: publish-npm`, tag-only, and it swallows per-repo dispatch
failures — so it can never affect the npm publish or the GitHub release.

An alignment PR is only the *first* step, and only ever per-repo: it does not release
the sibling packages, and it cannot know that `ssg` must wait for `router` and `cli`.
Driving the full rollout in dependency order is what
[`docs/ecosystem-release.md`](ecosystem-release.md) is for.

The default `GITHUB_TOKEN` **cannot** dispatch to other repos, so the job
authenticates with an **`ECOSYSTEM_DISPATCH_TOKEN`** secret. To activate the loop:

1. Create a **fine-grained PAT** at
   <https://github.com/settings/personal-access-tokens/new>:
   - **Resource owner**: `signalxjs` — *not* your personal account, or the repos
     will not appear in the list below.
   - **Repository access**: *Only select repositories* → every repo in
     `docs/ecosystem.json`. List them with:
     ```sh
     node -e "for (const c of require('./docs/ecosystem.json').consumers) console.log(c.repo)"
     ```
   - **Permissions**: Repository permissions → **`Contents: Read and write`**.
     Nothing else (`Metadata: Read` is added automatically and is expected).

   **There is no "Repository dispatch" permission** — `POST /repos/{owner}/{repo}/dispatches`
   is gated on `Contents: write`, which is broader than this job needs and is the
   narrowest GitHub offers for it (a GitHub App needs the same). The token can
   therefore write contents on those repos even though the workflow only sends an
   event; prefer a shorter expiry over hunting for a tighter scope.

   If the org requires approval for fine-grained tokens the request sits pending
   under Organization → Settings → Personal access tokens → Pending requests.
2. Store it as the `ECOSYSTEM_DISPATCH_TOKEN` Actions secret **in this (core)
   repo**: `gh secret set ECOSYSTEM_DISPATCH_TOKEN -R signalxjs/core`.
3. Confirm each consumer has `core-sync.yml` on its default branch:
   ```sh
   node -e "for (const c of require('./docs/ecosystem.json').consumers) console.log(c.repo)" \
     | xargs -I{} sh -c 'printf "%-14s " {}; if gh api repos/signalxjs/{}/contents/.github/workflows/core-sync.yml >/dev/null 2>&1; then echo present; else echo MISSING; fi'
   ```

You can prove the wiring without cutting a release — dispatch the *current* version and
expect "already aligned, no PR":

```sh
gh api repos/signalxjs/router/dispatches \
  -f event_type=core-released -F 'client_payload[version]=0.12.0'
gh run list -R signalxjs/router --workflow core-sync.yml --limit 1
```

A run appearing within ~30s means the token works end to end; the log should read
`sync-core: catalog already aligned to core 0.12 (no change)` and no PR should open.
When it does not:

| Symptom | Cause |
| --- | --- |
| `403` / `Resource not accessible by personal access token` | the token lacks `Contents: Read and write`, or that repo was not selected under *Only select repositories* |
| `404` | resource owner is your personal account instead of `signalxjs` |
| Dispatch accepted, no workflow run | `core-sync.yml` is not on that repo's default branch — check with the command above |

**Watch the expiry.** The job's guard catches an *unset* token, not an expired one:
every `gh api` call fails and each failure is swallowed per-repo, so an expired token
degrades silently back to the weekly cron with one line in a job log as the only
signal. Put a reminder on the expiry date.

If the secret is absent, `notify-consumers` logs that it's skipping and exits 0 —
consumers still pick up the release on `core-sync.yml`'s weekly cron.

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
   or an exact version like `1.2.3`). Skip `pnpm version:patch` — pnpm v11's
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
   every package lives at `X.Y.Z` on npm with provenance (npm versions carry no
   leading `v` — that is the git-tag convention), and the `vX.Y.Z` GitHub
   Release is marked latest. Confirm it, package by package — a tag run can fail
   partially and silently:
   ```sh
   node -e "for (const p of require('./docs/ecosystem.json').corePackages) console.log(p)" \
     | xargs -I{} sh -c 'printf "%-24s %s\n" {} "$(npm view {} version)"'
   ```
8. **The release is not finished here.** Twelve other repos pin these packages, several
   pin each other, and they only work if they are aligned and released in dependency
   order. Continue with **[`docs/ecosystem-release.md`](ecosystem-release.md)** — the
   runbook you point an agent at; it drives the whole rollout tier by tier.

### If something fails mid-release

- **Nothing published yet** (failure during `publish-npm` before any package
  succeeds): delete the tag locally and remotely
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), delete the GH
  release if one was created (`gh release delete vX.Y.Z`), fix the issue,
  re-tag.
- **Some packages published, others didn't**: do NOT delete the tag.
  npm versions are immutable. Bump to the next patch (`1.2.3` → `1.2.4`) so the
  failed packages can publish at the new version while the succeeded
  packages move forward too.

### Prereleases

Use a prerelease version (e.g. `1.2.3-rc.0`) and push the matching tag.
The publish script does not pass `--tag` automatically; add `--tag beta`
(or similar) to `release.yml`'s publish step if a non-`latest` dist-tag is
needed.

## What runs when

| Trigger                              | Workflow(s)                                            |
| ------------------------------------ | ------------------------------------------------------ |
| PR opened / updated                  | `ci.yml` (test matrix, verify-pack, coverage), `bundle-size.yml`, `release-drafter.yml`, `dependabot-automerge.yml` (if dependabot) |
| Push to `main`                       | `ci.yml`, `release-drafter.yml`                         |
| Push tag `v*.*.*`                    | `release.yml`                                           |
