# Maintainers Guide

One-time setup steps for the SignalX repo. Once configured, the GitHub Actions
workflows in `.github/workflows/` handle the rest.

## Required GitHub secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret           | Used by                  | How to obtain                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `NPM_TOKEN`      | `release.yml`            | npmjs.com → Access Tokens → Generate New Token → "Automation". Must have publish scope on all six `sigx` / `@sigx/*` packages. |
| `CODECOV_TOKEN`  | `ci.yml` (coverage job)  | codecov.io → link the repo → copy the upload token from the repo settings page. |

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed.

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

1. Bump versions: `pnpm version:patch` (or `version:minor` / `version:major`).
2. Rebuild and verify locally: `pnpm build && pnpm verify:pack`.
3. Update `CHANGELOG.md` (move `Unreleased` → the new version heading).
4. Commit: `git commit -am "chore: release v0.4.1"`.
5. Tag and push: `git tag v0.4.1 && git push --follow-tags`.
6. The `release.yml` workflow takes over: lint, typecheck, build, test,
   verify:pack, publish all six packages to npm with provenance, then publish
   the GitHub Release (finalizing the `release-drafter` draft if one exists).

To publish a prerelease, use a prerelease version (e.g. `0.4.1-rc.0`) and
push the matching tag. The publish script does not pass `--tag` automatically;
add `--tag beta` (or similar) to `release.yml` if a non-`latest` dist-tag is
needed.

## npm trusted publishing (follow-up — drop `NPM_TOKEN`)

Once the first tag-push release works end-to-end, switch each package to
trusted publishing so `NPM_TOKEN` is no longer required:

For each of the six packages on npmjs.com → package page → Settings →
Trusted Publishers → Add:

- Owner: `signalxjs`
- Repository: `core`
- Workflow filename: `release.yml`
- Environment: leave blank (or set if you want a manual approval gate)

Repeat for: `sigx`, `@sigx/reactivity`, `@sigx/runtime-core`,
`@sigx/runtime-dom`, `@sigx/server-renderer`, `@sigx/vite`.

After all six are configured, delete the `NPM_TOKEN` secret and remove the
`NPM_TOKEN` env var from the "Publish to npm" step in `release.yml`. pnpm
will pick up the OIDC token automatically.

## What runs when

| Trigger                              | Workflow(s)                                            |
| ------------------------------------ | ------------------------------------------------------ |
| PR opened / updated                  | `ci.yml` (test matrix, verify-pack, coverage), `bundle-size.yml`, `release-drafter.yml`, `dependabot-automerge.yml` (if dependabot) |
| Push to `main`                       | `ci.yml`, `release-drafter.yml`                         |
| Push tag `v*.*.*`                    | `release.yml`                                           |
