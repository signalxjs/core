# Ecosystem release runbook

**Point an agent at this file to roll a core release out across every sigx repo.**

Releasing core is step one of about thirty. Twelve other repos pin core packages,
several pin *each other*, and they only work if they are aligned and released in
dependency order. This file is the procedure; [`ecosystem.json`](ecosystem.json) is
the data it runs on. Neither is optional folklore — `pnpm verify:ecosystem` fails
CI when the manifest stops matching reality.

> **Prerequisite, one-time — not yet done:** the `ECOSYSTEM_DISPATCH_TOKEN` secret
> on this repo. Without it the alignment PRs still arrive, just on `core-sync.yml`'s
> weekly cron instead of within minutes of the release. See
> [MAINTAINERS.md → Notifying consumer repos](MAINTAINERS.md#notifying-consumer-repos).
>
> **Consumer-side machinery: live in 11 of 12 repos.** Every consumer except `i18n`
> carries `core-sync.yml`, `sync:core`, `verify:catalog` and a single-minor catalog
> on its default branch. `i18n` is waiting on an approving review
> ([signalxjs/i18n#16](https://github.com/signalxjs/i18n/pull/16)) — until that
> merges, align it by hand. Check the current state any time with:
>
> ```sh
> node -e "for (const c of require('./docs/ecosystem.json').consumers) console.log(c.repo)" >   | xargs -I{} sh -c 'printf "%-14s " {}; gh api repos/signalxjs/{}/contents/.github/workflows/core-sync.yml --jq .name 2>/dev/null || echo MISSING'
> ```

---

## 1. Why order matters

`@sigx/reactivity` keeps reactive state in **module-local variables**. Two physical
copies in one dependency graph silently split core's singletons — the topic
registry, the DI app-context token, `instanceof` identity — and reactivity stops
working with no error. Every consumer therefore pins core to a **single minor**
(`^X.Y.0` == `>=X.Y.0 <X.(Y+1).0`) through the `catalog:` block of its
`pnpm-workspace.yaml`, so pnpm hoists exactly one copy.

The consequence for releases: while an ecosystem package on npm still declares
`^0.12.0` and a sibling has moved to `^0.13.0`, any app depending on both resolves
**two** copies. The window is real but it closes as each tier publishes — which is
why tiers are released in order and why a red tier halts everything below it.

## 2. The tiers

Derived from every `packages/*/package.json` across the org, and enforced by
`scripts/check-ecosystem.mjs`: a repo's tier is strictly greater than the tier of
every repo publishing a package it consumes.

```
Tier 0   core                                        14 packages
─────────── barrier: all 14 live on npm ───────────
Tier 1   router · store · use · terminal · daisyui · monaco-editor      (core-only)
─────────── barrier: tier 1 live on npm ───────────
Tier 2   cli        ← @sigx/args, @sigx/terminal
         i18n       ← @sigx/store
         live-code  ← @sigx/daisyui, @sigx/monaco-editor, @sigx/router, @sigx/store
         pulse      ← @sigx/router, @sigx/store, @sigx/daisyui   (private app, publishes nothing)
─────────── barrier: tier 2 live on npm ───────────
Tier 3   ssg        ← @sigx/router, @sigx/cli, @sigx/args
         lynx       ← @sigx/cli, @sigx/terminal
```

Everything **within** a tier is independent — align and release them in parallel.
Regenerate this at any time rather than trusting the copy above:

```sh
node -e "const m=require('./docs/ecosystem.json');for(const t of [...new Set(m.consumers.map(c=>c.tier))].sort())console.log('tier '+t+': '+m.consumers.filter(c=>c.tier===t).map(c=>c.repo).join(' '))"
```

**Not in the rollout.** `signalxjs/devtools` pins core `^0.5.0`, sits at v0.0.1 and
has never been published — a rewrite, not a bump. `signalxjs/signalxjs.github.io`
is the docs agent's queue: file an issue there, never a PR from a source repo
(`AGENTS.md` → Documentation).

## 3. Before tier 1 — release core

Follow [MAINTAINERS.md → Releasing](MAINTAINERS.md#releasing). Then **verify the
publish actually happened** — tag runs have failed partially and silently before,
and npm versions are immutable, so a half-published tag is a bump-to-next-patch,
not a retry:

```sh
node -e "for (const p of require('./docs/ecosystem.json').corePackages) console.log(p)" \
  | xargs -I{} sh -c 'printf "%-24s %s\n" {} "$(npm view {} version)"'
```

All 14 must read the new version. Only then does tier 1 begin.

## 4. Per repo — the procedure

Identical for every repo. `X.Y` is the new core minor (e.g. `0.13`).

```sh
# 1. Branch. NEVER work on main. --from main matters: `pnpm wt new` branches from
#    the current HEAD, so running it inside another worktree drags that branch along.
pnpm wt new <N>-align-core-X.Y --from main
cd <repo>/branches/<N>-align-core-X.Y

# 2. Align the catalog. Rewrites only core entries; siblings are left alone.
pnpm sync:core X.Y

# 3. Install + prove it.
pnpm install --no-frozen-lockfile
pnpm verify:catalog      # no inline core deps; every catalog core entry is ^X.Y.0
pnpm build
pnpm typecheck
pnpm test
```

Then **verify the way the repo can be verified** (§5), open the PR with Copilot as
reviewer, resolve every inline thread, and merge through the queue — the standard
`AGENTS.md` flow. Sibling pins (`@sigx/router`, `@sigx/cli`, …) are *not* touched by
`sync:core`; bump those by hand in the same PR to the versions the previous tier
just published.

If the repo has user-facing changes beyond the bump, file its docs-repo issue
before merging (`AGENTS.md` → Documentation).

## 5. Verification, per repo

Run the strongest verification the repo actually has, from `verify` in the
manifest. Unit tests run on `happy-dom` — they do not prove a real browser renders.

| Repo | Unit | Beyond unit |
|---|---|---|
| `pulse` | `pnpm test` | **`pnpm smoke`** — playwright, the only real e2e suite in the ecosystem |
| `monaco-editor` | `pnpm test` | **`pnpm dev:basic`** — drive it in a browser |
| `i18n`, `ssg` | `pnpm test` | run an app from `examples/` and drive it in a browser |
| `terminal` | `pnpm test` | `pnpm showcase` — a TUI, not a browser surface |
| `lynx` | `pnpm test` | native (iOS/Android); no browser surface |
| `router`, `store`, `use`, `daisyui`, `cli`, `live-code` | `pnpm test` | none — unit tests are the verification |

For browser verification, start the app and drive it with the `claude-in-chrome`
tools: load the page, check the console for errors, exercise the repo's core
interaction, screenshot it, and attach the screenshot to the PR. On Windows,
confirm the dev server's PID actually changed after a restart before trusting what
you see — a stale process can keep serving the old port while the new one logs
"listening".

## 6. Autonomy — when to publish, when to stop

Publishing is irreversible: npm versions are immutable, and a broken release can
only be superseded, never withdrawn. Two paths.

### Green — publish without asking

**All** of these hold:

- `pnpm sync:core` changed **only** `pnpm-workspace.yaml` and `pnpm-lock.yaml`
- no source file was edited to make anything pass
- `verify:catalog`, `build`, `typecheck` and `test` all passed on the **first** run
- the repo's verification (§5) passed in full — the browser surface where it has one, the
  manual step (`terminal`'s TUI showcase, `lynx`'s native build) where that is what it has
- the PR merged with no Copilot feedback requiring a code change

Then finish the job:

```sh
node scripts/bump-version.js minor      # or patch — match what actually changed
# update CHANGELOG.md, refresh the lockfile, commit, then:
git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags
gh run watch -R signalxjs/<repo>        # release.yml
npm view <each published package> version   # confirm — partial tag runs are silent
```

### Amber — stop after the merge and hand back

**Any** of these:

- a source file had to change (a breaking-change migration, a type error, a test)
- a check needed a retry, or passed only after a fix
- a verification the repo HAS (§5 — browser or manual) could not actually be run; the unit
  suite does not substitute for it
- Copilot raised something that changed the code
- a sibling pin had to move by more than the expected minor

Merge the PR, then **stop before `git tag`**. Report: what changed beyond the
catalog, which check failed and why, and what you'd tag. A human decides.

### Failure

A red repo **halts every tier below it** — do not start tier N+1 with tier N
incomplete, or apps resolve two copies of `@sigx/reactivity` with no error to show
for it. Report the tier state and stop.

## 7. The orchestrator

[`.claude/workflows/ecosystem-release.mjs`](../.claude/workflows/ecosystem-release.mjs)
implements all of the above as a multi-subagent workflow: it reads `ecosystem.json`,
confirms core is fully published, fans one agent out per repo **within** a tier,
barriers between tiers, classifies each repo green or amber, halts the tiers below
anything that failed to publish, and ends with a hand-back report. Run it rather than
re-deriving the procedure by hand:

```
Workflow({ name: 'ecosystem-release' })
Workflow({ name: 'ecosystem-release', args: { dryRun: true } })    # align + PR, never tag
Workflow({ name: 'ecosystem-release', args: { onlyTiers: [1] } })  # one wave at a time
```

Start with `dryRun: true` on a release you have not driven before — it runs the whole
procedure and stops every repo at amber, so you see the shape of the rollout without
anything reaching npm.

It is a starting point, not a straitjacket — if a release has an unusual shape
(a breaking change that needs the same migration in six repos, say), read the
script, adapt it, and run the adapted version.

## 8. Keeping this honest

`docs/ecosystem.json` is the source of truth, and `pnpm verify:ecosystem` gates it
in CI. Update it — in the same PR — whenever:

- core adds or removes a published package (the check fails until you do)
- a repo joins or leaves the ecosystem
- a repo starts or stops consuming a sibling package (this can change its tier)

Then re-check against reality, which needs the network and so is not part of CI:

```sh
node scripts/check-ecosystem.mjs --remote
```
