# Maintainers Guide

One-time setup steps for the SignalX repo. Once configured, the GitHub Actions
workflows in `.github/workflows/` handle the rest.

## Required GitHub secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret           | Used by                  | How to obtain                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `CODECOV_TOKEN`  | `ci.yml` (coverage job)  | codecov.io → link the repo → copy the upload token from the repo settings page. Required because `main` is a protected branch — Codecov rejects tokenless uploads on protected branches even when the org auth setting is "Not required". |

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

If you ever rename the workflow file or add an environment gate, the
trusted-publisher entries on npmjs.com must be updated to match — otherwise
publishing will fail with `EAUTHIP`. `scripts/publish.js` still accepts an
`NPM_TOKEN` env var as a fallback for local publishes (e.g. emergency manual
release from a laptop).

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

## What runs when

| Trigger                              | Workflow(s)                                            |
| ------------------------------------ | ------------------------------------------------------ |
| PR opened / updated                  | `ci.yml` (test matrix, verify-pack, coverage), `bundle-size.yml`, `release-drafter.yml`, `dependabot-automerge.yml` (if dependabot) |
| Push to `main`                       | `ci.yml`, `release-drafter.yml`                         |
| Push tag `v*.*.*`                    | `release.yml`                                           |
