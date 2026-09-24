/**
 * ecosystem-release — roll a core release out across every sigx consumer repo,
 * in dependency order, one tier at a time.
 *
 * The procedure this automates is `docs/ecosystem-release.md`; the data it runs on
 * is `docs/ecosystem.json`. Read the runbook before changing this script — the
 * green/amber autonomy rule in §6 is a deliberate safety boundary, not a default.
 *
 * Run it:
 *     Workflow({ name: 'ecosystem-release' })
 *     Workflow({ name: 'ecosystem-release', args: { coreVersion: '0.13.0' } })
 *     Workflow({ name: 'ecosystem-release', args: { dryRun: true } })   // align + PR, never tag
 *     Workflow({ name: 'ecosystem-release', args: { onlyTiers: [1] } }) // one wave at a time
 *
 * Workflow scripts have no filesystem access, so phase 1 spends one agent reading
 * the manifest rather than embedding a copy that would drift from it.
 */

export const meta = {
    name: 'ecosystem-release',
    description: 'Align and release every sigx consumer repo against a new core version, in tier order',
    whenToUse:
        'After core is tagged and all its packages are live on npm. Drives docs/ecosystem-release.md across every consumer repo in docs/ecosystem.json.',
    phases: [
        { title: 'Plan', detail: 'read docs/ecosystem.json + confirm core is fully published on npm' },
        { title: 'Preflight', detail: 'confirm the catalog machinery is on every consumer default branch (remote, not local)' },
        { title: 'Tier 1', detail: 'core-only consumers — align, verify, release' },
        { title: 'Tier 2', detail: 'consumers of tier-1 siblings' },
        { title: 'Tier 3', detail: 'consumers of tier-2 siblings' },
        { title: 'Tier 4', detail: 'consumers of tier-3 siblings' },
        { title: 'Report', detail: 'hand-back report of everything left amber' },
    ],
}

const MANIFEST_SCHEMA = {
    type: 'object',
    required: ['coreVersion', 'corePublished', 'consumers'],
    properties: {
        coreVersion: { type: 'string', description: 'The core version being rolled out, e.g. "0.13.0"' },
        coreMinor: { type: 'string', description: 'Just the minor, e.g. "0.13"' },
        corePublished: {
            type: 'boolean',
            description: 'True only if EVERY package in corePackages reads coreVersion on npm',
        },
        unpublishedCorePackages: { type: 'array', items: { type: 'string' } },
        downstreamChanges: {
            type: 'array',
            items: { type: 'string' },
            description:
                'Downstream-observable behaviour changes in core since the previous release, one line each, from CHANGELOG.md',
        },
        consumers: {
            type: 'array',
            items: {
                type: 'object',
                required: ['repo', 'tier'],
                properties: {
                    repo: { type: 'string' },
                    tier: { type: 'number' },
                    publishes: { type: 'array', items: { type: 'string' } },
                    consumesSiblings: { type: 'array', items: { type: 'string' } },
                    private: { type: 'boolean' },
                    catalog: { type: 'string', description: 'complete | partial | missing' },
                    catalogTodo: { type: 'string' },
                    verifyUnit: { type: 'string' },
                    verifyBrowser: { type: 'string', description: 'empty when the repo has no browser surface' },
                    verifyBrowserRequired: {
                        type: 'boolean',
                        description:
                            'true when the verification needs an interactive browser a rollout session cannot supply',
                    },
                    verifyManual: {
                        type: 'string',
                        description:
                            'a non-browser verification the repo still has (a TUI showcase, a native build); empty when there is none',
                    },
                },
            },
        },
    },
}

const ALIGN_SCHEMA = {
    type: 'object',
    required: ['status', 'summary'],
    properties: {
        repo: {
            type: 'string',
            description:
                'Optional, debug only — which repo you worked on, in whatever form. Nothing matches on it: the workflow attributes each result to its manifest entry positionally, because relying on this field is what silently disabled the tier barrier (#465).',
        },
        status: {
            type: 'string',
            enum: ['green', 'amber', 'failed'],
            description:
                'green = only the catalog+lockfile changed, everything passed first try, verification passed, and it is now PUBLISHED. amber = merged but NOT tagged, a human must decide. failed = could not get to a mergeable state.',
        },
        summary: { type: 'string', description: 'One paragraph: what changed and what happened.' },
        prUrl: { type: 'string' },
        releasedVersion: {
            type: 'string',
            description: 'Set only when status is green: the pushed version, or "none" when runbook §6 "Which version" called for no release',
        },
        publishedPackages: { type: 'array', items: { type: 'string' } },
        amberReason: { type: 'string', description: 'Why a human is needed. Required when status is amber.' },
        sourceFilesChanged: { type: 'array', items: { type: 'string' } },
        verification: { type: 'string', description: 'What was actually run, and whether a browser was driven.' },
        blockedBy: { type: 'string' },
    },
}

// `args` has reached this script as a JSON-encoded STRING rather than an object
// (0.15.1 wave, #629): `args.onlyTiers` read as undefined and tier 1 silently re-ran.
let args_
try {
    args_ = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
} catch (e) {
    return { ok: false, error: `args arrived as a string that is not valid JSON (${e.message}): ${String(args).slice(0, 200)}` }
}
if (!args_ || typeof args_ !== 'object' || Array.isArray(args_)) {
    return { ok: false, error: `args must be an object (or a JSON string of one); got ${JSON.stringify(args_)}` }
}
const dryRun = args_.dryRun === true

// ---------------------------------------------------------------- Phase: Plan

phase('Plan')

const plan = await agent(
    `You are preparing an ecosystem-wide release rollout for the sigx monorepo at this repo root.

1. Read \`docs/ecosystem.json\` and \`docs/ecosystem-release.md\` in full.
2. Determine the core version being rolled out. ${
        args_.coreVersion
            ? `It was given explicitly: "${args_.coreVersion}". Use it.`
            : 'Read it from `packages/reactivity/package.json` (all core packages are lockstep-versioned).'
    }
3. For EVERY package in the manifest's \`corePackages\`, run \`npm view <pkg> version\` and compare
   against that core version. Set \`corePublished\` true only if every single one matches, and list
   any that do not in \`unpublishedCorePackages\`. Do not guess — actually run the command.
   This matters: core tag runs have failed partially and silently before, and npm versions are
   immutable, so a half-published core must be fixed before any consumer moves.
4. Return every consumer from the manifest, flattening \`verify.unit\` to \`verifyUnit\`,
   \`verify.browser\` to \`verifyBrowser\`, \`verify.manual\` to \`verifyManual\` (empty
   string when a field is null or absent) and \`verify.browserRequired\` to
   \`verifyBrowserRequired\` (false when absent). Do not drop \`verify.manual\` — it is how a
   repo with no browser surface still says how it can be exercised.
5. Pre-flight the changelog (runbook §3): read every section of the root \`CHANGELOG.md\`
   (and each package's own \`CHANGELOG.md\` under \`packages/\`) newer than the core version the consumers
   are currently on, and list in \`downstreamChanges\` every entry a consumer could OBSERVE —
   \`Changed\`, \`Deprecated\`, \`Removed\`, \`Security\`, and any \`Fixed\` or \`Added\` entry
   that changes a return value, a type, a warning or a serialized shape for an input that
   already worked. One line each: package, the change, the kind of consumer code it hits.

Return data only.`,
    { schema: MANIFEST_SCHEMA, label: 'read manifest + verify core on npm', phase: 'Plan' },
)

if (!plan) {
    return { ok: false, error: 'Planning agent failed — could not read the manifest.' }
}

if (!plan.corePublished) {
    log(`HALT: core ${plan.coreVersion} is not fully published. Missing: ${(plan.unpublishedCorePackages ?? []).join(', ')}`)
    return {
        ok: false,
        halted: 'core-not-published',
        coreVersion: plan.coreVersion,
        unpublishedCorePackages: plan.unpublishedCorePackages ?? [],
        next: 'Fix the core publish first (MAINTAINERS.md → "If something fails mid-release"). npm versions are immutable: bump to the next patch rather than re-tagging.',
    }
}

const coreMinor = plan.coreMinor || plan.coreVersion.split('.').slice(0, 2).join('.')

const wanted = args_.onlyTiers
const consumers = plan.consumers.filter((c) => !wanted || wanted.includes(c.tier))
const tiers = [...new Set(consumers.map((c) => c.tier))].sort((a, b) => a - b)

log(`Core ${plan.coreVersion} confirmed live on npm across every core package.`)
const downstreamChanges = plan.downstreamChanges ?? []
log(`Pre-flight: ${downstreamChanges.length} downstream-observable core change(s) in this release.`)
for (const ch of downstreamChanges) log(`  - ${ch}`)
log(`Rolling out to ${consumers.length} repos across ${tiers.length} tier(s): ${tiers.join(', ')}${dryRun ? ' — DRY RUN, nothing will be tagged' : ''}`)

// ------------------------------------------------------------ Phase: Preflight

phase('Preflight')

// Establish, from the REMOTE default branch, which consumers actually carry the
// machinery — before any agent looks at a working copy.
//
// On the first live 0.13.0 run (#465) four tier-1 agents reported the catalog
// machinery as entirely absent and the rollout stalled. It was present on every
// default branch; their LOCAL checkouts were 2-10 commits stale, predating the
// rollout, and the runbook did not tell them to fetch. Four independent agents
// produced the same confident, wrong answer, and nothing contradicted them.
//
// A single API read settles it up front, so a stale working copy can no longer be
// mistaken for a missing feature — and if the machinery genuinely is missing, the
// run stops here naming the repos instead of burning a tier discovering it.
const preflight = await agent(
    `Check, for each of these repos, whether the core catalog-sync machinery is present on its DEFAULT BRANCH.

Repos: ${consumers.map((c) => c.repo).join(', ')}

Use the GitHub API — NOT a local clone, and NOT a working copy. Local checkouts of these
repos are frequently many commits stale, which is exactly the failure this check exists to
rule out. For each repo run:

    gh api repos/signalxjs/<repo>/contents/.github/workflows/core-sync.yml --jq .name
    gh api repos/signalxjs/<repo>/contents/scripts/sync-core.mjs --jq .name
    gh api repos/signalxjs/<repo>/contents/pnpm-workspace.yaml --jq .content   # decode, look for a \`catalog:\` block

Report per repo whether each is present. \`ready\` is true only when all three are.

Return data only.`,
    {
        label: 'machinery preflight (remote default branches)',
        phase: 'Preflight',
        schema: {
            type: 'object',
            required: ['repos'],
            properties: {
                repos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['repo', 'ready'],
                        properties: {
                            repo: { type: 'string', description: 'bare name, e.g. "router"' },
                            ready: { type: 'boolean' },
                            missing: { type: 'array', items: { type: 'string' } },
                        },
                    },
                },
            },
        },
    },
)

const notReady = (preflight?.repos ?? []).filter((r) => !r.ready)
if (notReady.length) {
    log(`HALT: ${notReady.length} consumer(s) lack the catalog machinery on their default branch.`)
    for (const r of notReady) log(`  ${r.repo}: missing ${(r.missing ?? ['?']).join(', ')}`)
    return {
        ok: false,
        halted: 'machinery-missing',
        repos: notReady,
        next: 'Land the repo-template catalog migration on those default branches first (docs/ecosystem-release.md §8). This was checked against the REMOTE default branch, so it is not a stale-checkout artifact.',
    }
}
log(`Preflight OK — all ${consumers.length} consumers carry the machinery on their default branch.`)

// ------------------------------------------------------- Phase: tier by tier

/** The per-repo prompt. Deliberately verbatim about the autonomy rule. */
function alignPrompt(c) {
    const siblings = (c.consumesSiblings ?? []).join(', ') || 'none'
    return `Align and release \`signalxjs/${c.repo}\` against sigx core ${plan.coreVersion}.

Follow \`docs/ecosystem-release.md\` in the sigx core repo (read it first — §4 is the procedure,
§5 verification, §6 the autonomy rule) and \`AGENTS.md\` in ${c.repo} itself for that repo's
issue → worktree → PR → Copilot → merge-queue flow.

Repo facts from the ecosystem manifest:
- publishes: ${(c.publishes ?? []).join(', ') || 'nothing (private)'}
- consumes siblings: ${siblings}
- catalog state: ${c.catalog ?? 'unknown'}${c.catalogTodo ? ` — ${c.catalogTodo}` : ''}
- unit verification: ${c.verifyUnit || 'pnpm test'}
- beyond unit: ${c.verifyBrowser || c.verifyManual || 'none — unit tests ARE the verification for this repo'}${c.verifyBrowserRequired ? ' (INTERACTIVE — human queue, see step 6)' : ''}

Downstream-observable core changes in this release (runbook §3 pre-flight) — expect these,
do not rediscover them by test failure:
${downstreamChanges.length ? downstreamChanges.map((ch) => `- ${ch}`).join('\n') : '- none listed'}

Steps:
1. **SYNC THE LOCAL CHECKOUT FIRST — before anything else.** Local checkouts of these
   repos go stale by many commits, and reading one is indistinguishable from reading a
   repo that never had the machinery:

   \`\`\`sh
   cd <repo>/main
   git fetch origin main
   git rev-list --count HEAD..origin/main   # MUST print 0 before you continue
   git pull --ff-only origin main
   \`\`\`

   On the first live 0.13.0 rollout this step did not exist, and four agents reported
   the catalog machinery as entirely missing from repos that had carried it for days —
   their checkouts were 2-10 commits behind. A preflight has already confirmed via the
   GitHub API that this repo HAS \`core-sync.yml\`, \`scripts/sync-core.mjs\` and a
   \`catalog:\` block on its default branch. **If your working copy disagrees, your
   working copy is stale — re-sync it. Do not report the machinery as missing.**

   If core's release already opened a \`core-released\` bot PR in this repo (\`gh pr list\`),
   ADOPT it instead of opening a duplicate: \`git fetch origin <bot-branch>\`,
   \`pnpm wt new <name> --from origin/<bot-branch>\`, and push your work back with
   \`git push origin HEAD:<bot-branch>\`. Bot PRs get no CI run until you push to them.

2. Otherwise create the worktree: \`pnpm wt new <issue>-align-core-${coreMinor} --from main\`.
   NEVER work on main. \`pnpm wt new\` branches from the CURRENT HEAD, so \`--from main\`
   is load-bearing.
3. \`pnpm sync:core ${coreMinor}\`, then \`pnpm install --no-frozen-lockfile --prefer-online\`
   (the npm registry serves stale dist-tags for minutes after a publish; a CI job that
   resolved the old version is fixed with \`gh run rerun <id> --failed\`, not a code change).
   If \`sync:core\` or \`verify:catalog\` is genuinely absent AFTER a confirmed-fresh
   checkout, that is the finding — report status "failed" rather than hand-editing.
4. Bump sibling pins by hand to the versions the previous tier just published (${siblings}).
   \`sync:core\` deliberately does not touch these.
5. \`pnpm verify:catalog && pnpm build && pnpm typecheck && pnpm test\`.
6. Verification per §5. ${
        c.verifyBrowserRequired
            ? `This repo's verification (\`${c.verifyBrowser}\`) needs an INTERACTIVE browser that a rollout session cannot supply (manifest \`verify.browserRequired\`). Do not attempt it. Run everything else, merge, then report status "amber" with amberReason starting "human queue: interactive browser verification" and the exact command a human should run and what to look for.`
            : c.verifyBrowser
            ? `This repo HAS a browser surface — run \`${c.verifyBrowser}\` and drive it with the claude-in-chrome tools: load the page, read the console for errors, exercise the main interaction, screenshot it, attach the screenshot to the PR. On Windows verify the dev server PID actually changed after any restart.`
            : c.verifyManual
              ? `This repo has no BROWSER surface, but it is not unit-tests-only either: ${c.verifyManual}. Exercise it as far as the environment allows and say in \`verification\` exactly what you ran and what you could not. If it could not be exercised at all, that is an AMBER reason — do not treat the unit suite as sufficient.`
              : 'This repo has no browser surface and no manual verification; the unit suite IS the verification.'
    }
7. Open the PR (reference the issue so it auto-closes), request Copilot review via the
   requested_reviewers API (\`-f 'reviewers[]=copilot-pull-request-reviewer[bot]'\`), address
   every actionable comment, RESOLVE every inline thread over GraphQL (unresolved threads
   block the merge), then merge per the repo's AGENTS.md — consumer repos have no merge
   queue: \`gh pr merge <pr> --squash --subject "<title> (#<pr>)" --body "<body>"\`.

Then apply the autonomy rule EXACTLY:

GREEN — publish yourself. Only if ALL hold: \`sync:core\` changed nothing but
\`pnpm-workspace.yaml\` and \`pnpm-lock.yaml\`; you edited no source file; verify:catalog,
build, typecheck and test all passed on the FIRST run; verification passed; Copilot's review
required no code change.${dryRun ? '\n  >>> DRY RUN IS ON: even on green, STOP after the merge. Do not bump, tag or push. Report status "amber" with amberReason "dry run". <<<' : `
  Choose the version per runbook §6 "Which version": a change to any PUBLISHED core range
  ships as a downstream minor (a core major in a repo already >= 1.0: major); a within-range
  retarget (catalog + lockfile only — every core minor and patch from 1.0, since packages
  peer \`^1.0.0\`) ships as a patch, or not at all when main has nothing else unreleased (then report green with releasedVersion "none").
  Then: bump the version, update CHANGELOG.md, refresh the lockfile, commit, tag and push;
  watch release.yml; and CONFIRM with \`npm view <pkg> version --prefer-online\` for every package
  this repo publishes — partial tag runs fail silently. A release job that printed every package
  as published and then failed its own read-back is registry lag: \`gh run rerun <id> --failed\`,
  never a re-tag or a bump. Report status "green" with releasedVersion and
  publishedPackages.`}

AMBER — stop after the merge, do NOT tag. Any of: a source file had to change; any check needed
a retry; a verification this repo HAS (browser or manual) could not actually be run; Copilot's
feedback changed the code; a sibling pin had to move more than the expected minor. Report status "amber", list sourceFilesChanged, and
say in amberReason exactly what a human needs to decide. npm versions are immutable — when in
doubt, amber.

FAILED — you could not reach a mergeable state. Report status "failed" and what blocked you.

Return data only.`
}

const byTier = new Map()
for (const c of consumers) {
    if (!byTier.has(c.tier)) byTier.set(c.tier, [])
    byTier.get(c.tier).push(c)
}

const all = []

// The barrier is EDGE-WISE (runbook §6 "Amber and failed hold edge-wise", #629).
// A repo that did not publish blocks exactly the repos that consume one of its
// packages (`consumesSiblings`) — and, transitively, the consumers of THOSE, since
// a held repo publishes nothing either. Everything else proceeds. The 0.15.1 wave
// ran a blanket halt: i18n and live-code went amber, nothing downstream consumed
// them, and tiers 3-4 sat idle anyway.
const blocked = new Map() // npm package name -> the repo that did not publish it
const held = [] // { repo, tier, blockedBy: [pkg (repo)] }

for (const tier of tiers) {
    const title = `Tier ${tier}`
    phase(title)

    const group = []
    for (const c of byTier.get(tier)) {
        const hits = (c.consumesSiblings ?? []).filter((p) => blocked.has(p))
        if (!hits.length) {
            group.push(c)
            continue
        }
        const blockedBy = hits.map((p) => `${p} (${blocked.get(p)})`)
        held.push({ repo: c.repo, tier, blockedBy })
        for (const p of c.publishes ?? []) blocked.set(p, c.repo)
        all.push({
            repo: c.repo,
            status: 'held',
            summary: `Not started: consumes ${blockedBy.join(', ')}, which did not publish.`,
            blockedBy: blockedBy.join(', '),
        })
        log(`HOLD ${c.repo}: consumes ${blockedBy.join(', ')} — not published. Starting it would resolve two copies of @sigx/reactivity.`)
    }
    if (!group.length) {
        log(`Tier ${tier}: every repo held — nothing to run.`)
        continue
    }
    log(`Tier ${tier}: ${group.map((c) => c.repo).join(', ')}`)

    // A genuine barrier, not a stylistic one: a repo cannot install until every
    // sibling package it consumes is live on npm, or it resolves two copies of
    // @sigx/reactivity and reactivity silently breaks.
    const results = await parallel(
        group.map((c) => () => agent(alignPrompt(c), { schema: ALIGN_SCHEMA, label: c.repo, phase: title })),
    )

    // Pin each result to the manifest entry BY POSITION, not by the name the agent
    // returned. parallel() preserves order, so index i is group[i] — that is a fact
    // about the runtime, whereas `r.repo` is a free-text field an LLM filled in.
    //
    // Trusting the returned name is what silently disabled the halt barrier on the
    // first live 0.13.0 run (#465): the prompt says "Align and release
    // `signalxjs/router`", so agents returned the PREFIXED slug while the manifest
    // holds the bare name. `group.find(g => g.repo === r.repo)` never matched,
    // `unpublished` was always empty, and tier 2 ran even though tier 1 had
    // published nothing. A barrier that cannot fire is worse than no barrier — it
    // reads as "the tier was fine".
    const settled = results.map((r, i) => ({
        ...(r ?? { status: 'failed', summary: 'Agent died or was skipped; no result returned.' }),
        repo: group[i].repo, // authoritative — overwrites whatever the agent reported
        reportedRepo: r?.repo,
        _entry: group[i],
    }))
    all.push(...settled.map(({ _entry, ...rest }) => rest))

    const failed = settled.filter((r) => r.status === 'failed')
    const amber = settled.filter((r) => r.status === 'amber')
    const green = settled.filter((r) => r.status === 'green')
    log(`Tier ${tier} done — ${green.length} green, ${amber.length} amber, ${failed.length} failed.`)

    // Anything not published blocks its consumers: their sibling pins have nothing
    // to point at. Record its packages; the next tiers hold exactly those consumers.
    const unpublished = [...failed, ...amber].filter(
        (r) => !r._entry.private && (r._entry.publishes ?? []).length > 0,
    )
    for (const r of unpublished) for (const p of r._entry.publishes) blocked.set(p, r.repo)
    if (unpublished.length) {
        log(`Tier ${tier}: ${unpublished.map((r) => r.repo).join(', ')} did not publish — their consumers in later tiers will be held.`)
    }
}

// -------------------------------------------------------------- Phase: Report

phase('Report')

const report = await agent(
    `Write the hand-back report for a sigx ecosystem rollout of core ${plan.coreVersion}${dryRun ? ' (DRY RUN — nothing was tagged)' : ''}.

Per-repo results:
${JSON.stringify(all, null, 2)}

${held.length ? `These repos were HELD (never started) because a sibling they consume did not publish: ${held.map((h) => `${h.repo} (tier ${h.tier}) <- ${h.blockedBy.join(', ')}`).join('; ')}. Every other repo ran.` : 'Every planned repo ran.'}

Write it for a maintainer who needs to finish the job. Structure:
1. One-line state of the ecosystem (how many published, how many waiting on a human).
2. **Needs a decision** — every amber repo: what changed beyond the catalog, why it is amber,
   what you would tag, and the exact next command. This is the part that matters; be specific.
   List the "human queue: interactive browser verification" ambers separately, with the
   command to run and what to look for.
3. **Failed** — every failed repo and what blocked it.
4. **Published** — a table of repo / version / packages confirmed on npm.
5. **Held** — every held repo, which unpublished sibling holds it, and what unblocks it.
6. Anything that should change in \`docs/ecosystem.json\` or \`docs/ecosystem-release.md\` as a
   result of what you saw (a stale catalog note, a wrong tier, a missing verification command).

Markdown. No preamble.`,
    { label: 'hand-back report', phase: 'Report' },
)

return {
    ok: held.length === 0 && all.every((r) => r.status === 'green'),
    dryRun,
    coreVersion: plan.coreVersion,
    held,
    counts: {
        green: all.filter((r) => r.status === 'green').length,
        amber: all.filter((r) => r.status === 'amber').length,
        failed: all.filter((r) => r.status === 'failed').length,
        held: held.length,
    },
    repos: all,
    report,
}
