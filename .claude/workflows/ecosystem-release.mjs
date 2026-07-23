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
        'After core is tagged and all its packages are live on npm. Drives docs/ecosystem-release.md across all 12 consumer repos.',
    phases: [
        { title: 'Plan', detail: 'read docs/ecosystem.json + confirm core is fully published on npm' },
        { title: 'Tier 1', detail: 'core-only consumers — align, verify, release' },
        { title: 'Tier 2', detail: 'consumers of tier-1 siblings' },
        { title: 'Tier 3', detail: 'consumers of tier-2 siblings' },
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
    required: ['repo', 'status', 'summary'],
    properties: {
        repo: { type: 'string' },
        status: {
            type: 'string',
            enum: ['green', 'amber', 'failed'],
            description:
                'green = only the catalog+lockfile changed, everything passed first try, verification passed, and it is now PUBLISHED. amber = merged but NOT tagged, a human must decide. failed = could not get to a mergeable state.',
        },
        summary: { type: 'string', description: 'One paragraph: what changed and what happened.' },
        prUrl: { type: 'string' },
        releasedVersion: { type: 'string', description: 'Set only when status is green and the tag was pushed' },
        publishedPackages: { type: 'array', items: { type: 'string' } },
        amberReason: { type: 'string', description: 'Why a human is needed. Required when status is amber.' },
        sourceFilesChanged: { type: 'array', items: { type: 'string' } },
        verification: { type: 'string', description: 'What was actually run, and whether a browser was driven.' },
        blockedBy: { type: 'string' },
    },
}

const args_ = args ?? {}
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
   \`verify.browser\` to \`verifyBrowser\` and \`verify.manual\` to \`verifyManual\` (empty
   string when a field is null or absent). Do not drop \`verify.manual\` — it is how a repo
   with no browser surface still says how it can be exercised.

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
log(`Rolling out to ${consumers.length} repos across ${tiers.length} tier(s): ${tiers.join(', ')}${dryRun ? ' — DRY RUN, nothing will be tagged' : ''}`)

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
- beyond unit: ${c.verifyBrowser || c.verifyManual || 'none — unit tests ARE the verification for this repo'}

Steps:
1. Clone/locate the repo in the standard layout and create a worktree from main:
   \`pnpm wt new <issue>-align-core-${coreMinor} --from main\`. NEVER work on main.
   \`pnpm wt new\` branches from the CURRENT HEAD, so \`--from main\` is load-bearing.
2. \`pnpm sync:core ${coreMinor}\`, then \`pnpm install --no-frozen-lockfile\`.
   If \`sync:core\` or \`verify:catalog\` is missing from this repo, that is itself the finding —
   report status "failed" with that as the reason rather than improvising a hand edit.
3. Bump sibling pins by hand to the versions the previous tier just published (${siblings}).
   \`sync:core\` deliberately does not touch these.
4. \`pnpm verify:catalog && pnpm build && pnpm typecheck && pnpm test\`.
5. Verification per §5. ${
        c.verifyBrowser
            ? `This repo HAS a browser surface — run \`${c.verifyBrowser}\` and drive it with the claude-in-chrome tools: load the page, read the console for errors, exercise the main interaction, screenshot it, attach the screenshot to the PR. On Windows verify the dev server PID actually changed after any restart.`
            : c.verifyManual
              ? `This repo has no BROWSER surface, but it is not unit-tests-only either: ${c.verifyManual}. Exercise it as far as the environment allows and say in \`verification\` exactly what you ran and what you could not. If it could not be exercised at all, that is an AMBER reason — do not treat the unit suite as sufficient.`
              : 'This repo has no browser surface and no manual verification; the unit suite IS the verification.'
    }
6. Open the PR (reference the issue so it auto-closes), request Copilot review via the
   requested_reviewers API, address every actionable comment, RESOLVE every inline thread
   over GraphQL (unresolved threads block the merge), then \`gh pr merge --squash --auto\`.

Then apply the autonomy rule EXACTLY:

GREEN — publish yourself. Only if ALL hold: \`sync:core\` changed nothing but
\`pnpm-workspace.yaml\` and \`pnpm-lock.yaml\`; you edited no source file; verify:catalog,
build, typecheck and test all passed on the FIRST run; verification passed; Copilot's review
required no code change.${dryRun ? '\n  >>> DRY RUN IS ON: even on green, STOP after the merge. Do not bump, tag or push. Report status "amber" with amberReason "dry run". <<<' : `
  Then: bump the version, update CHANGELOG.md, refresh the lockfile, commit, tag and push;
  watch release.yml; and CONFIRM with \`npm view <pkg> version\` for every package this repo
  publishes — partial tag runs fail silently. Report status "green" with releasedVersion and
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
let haltedAt = null

for (const tier of tiers) {
    const group = byTier.get(tier)
    const title = `Tier ${tier}`
    phase(title)
    log(`Tier ${tier}: ${group.map((c) => c.repo).join(', ')}`)

    // A genuine barrier, not a stylistic one: a tier-N+1 repo cannot install until
    // every package tier N publishes is live on npm, or it resolves two copies of
    // @sigx/reactivity and reactivity silently breaks.
    const results = await parallel(
        group.map((c) => () => agent(alignPrompt(c), { schema: ALIGN_SCHEMA, label: c.repo, phase: title })),
    )

    const settled = results.map((r, i) =>
        r ?? { repo: group[i].repo, status: 'failed', summary: 'Agent died or was skipped; no result returned.' },
    )
    all.push(...settled)

    const failed = settled.filter((r) => r.status === 'failed')
    const amber = settled.filter((r) => r.status === 'amber')
    const green = settled.filter((r) => r.status === 'green')
    log(`Tier ${tier} done — ${green.length} green, ${amber.length} amber, ${failed.length} failed.`)

    // Anything not published blocks the tiers below: their sibling pins have nothing
    // to point at. Halt rather than half-release the ecosystem.
    const unpublished = [...failed, ...amber].filter((r) => {
        const c = group.find((g) => g.repo === r.repo)
        return c && !c.private && (c.publishes ?? []).length > 0
    })
    if (unpublished.length && tier !== tiers[tiers.length - 1]) {
        haltedAt = { tier, repos: unpublished.map((r) => r.repo) }
        log(`HALT after tier ${tier}: ${unpublished.map((r) => r.repo).join(', ')} did not publish. Later tiers would resolve two copies of @sigx/reactivity.`)
        break
    }
}

// -------------------------------------------------------------- Phase: Report

phase('Report')

const report = await agent(
    `Write the hand-back report for a sigx ecosystem rollout of core ${plan.coreVersion}${dryRun ? ' (DRY RUN — nothing was tagged)' : ''}.

Per-repo results:
${JSON.stringify(all, null, 2)}

${haltedAt ? `The rollout HALTED after tier ${haltedAt.tier} because these repos did not publish: ${haltedAt.repos.join(', ')}. Tiers below it were never started.` : 'Every planned tier ran.'}

Write it for a maintainer who needs to finish the job. Structure:
1. One-line state of the ecosystem (how many published, how many waiting on a human).
2. **Needs a decision** — every amber repo: what changed beyond the catalog, why it is amber,
   what you would tag, and the exact next command. This is the part that matters; be specific.
3. **Failed** — every failed repo and what blocked it.
4. **Published** — a table of repo / version / packages confirmed on npm.
5. **Not yet started** — any tier that never ran, and what unblocks it.
6. Anything that should change in \`docs/ecosystem.json\` or \`docs/ecosystem-release.md\` as a
   result of what you saw (a stale catalog note, a wrong tier, a missing verification command).

Markdown. No preamble.`,
    { label: 'hand-back report', phase: 'Report' },
)

return {
    ok: !haltedAt,
    dryRun,
    coreVersion: plan.coreVersion,
    haltedAt,
    counts: {
        green: all.filter((r) => r.status === 'green').length,
        amber: all.filter((r) => r.status === 'amber').length,
        failed: all.filter((r) => r.status === 'failed').length,
    },
    repos: all,
    report,
}
