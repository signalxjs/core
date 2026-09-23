#!/usr/bin/env node
/**
 * check-orchestrator.mjs — regression guard for `.claude/workflows/ecosystem-release.mjs`.
 *
 * BE CLEAR ABOUT WHAT THIS IS: a source-level lint, not a behavioural test. Workflow
 * scripts run inside the Workflow tool's sandbox with no filesystem or module access,
 * so the orchestrator cannot be imported and its tier barrier cannot be exercised from
 * vitest. What CAN be done is to pin the shape of the code that broke, so the specific
 * regression cannot come back unnoticed.
 *
 * The bug it guards (#465): the between-tier halt barrier matched agent-reported repo
 * names against manifest names —
 *
 *     const c = group.find((g) => g.repo === r.repo)   // "router" vs "signalxjs/router"
 *
 * The prompt says "Align and release `signalxjs/router`", so agents returned the
 * PREFIXED slug, `find` never matched, `unpublished` was always empty, and the barrier
 * never fired. On the first live 0.13.0 rollout tier 2 ran even though every tier-1
 * repo had published nothing. A barrier that cannot fire is worse than no barrier —
 * it reads as "the tier was fine".
 *
 * The fix is to stop trusting the returned name at all: `parallel()` preserves order,
 * so result i belongs to group[i]. That is a runtime guarantee; the returned string is
 * free text an LLM filled in.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(repoRoot, '.claude', 'workflows', 'ecosystem-release.mjs');

if (!existsSync(path)) {
    console.error(`check-orchestrator: ${path} is missing — the rollout has no orchestrator.`);
    process.exit(1);
}
const raw = readFileSync(path, 'utf8');

// Check CODE, not prose. The orchestrator's comments quote the buggy line verbatim so
// the next reader understands what went wrong — matching against the raw file would
// flag that explanation as the bug itself, which would either delete a useful comment
// or train someone to ignore this check.
// Block comments go first, so their `*` continuation lines are already gone — only
// whole-line `//` comments remain to strip. Dropping `*`-leading lines as well would
// also eat real code (a generator method) and prompt text (a markdown bullet), which
// is how a source lint starts producing confident wrong answers of its own.
const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const errors = [];

// 1. Results must be pinned to the manifest entry BY INDEX, not by returned name.
if (!/repo:\s*group\[i\]\.repo/.test(src)) {
    errors.push(
        'the per-tier results no longer pin `repo: group[i].repo`. Result i MUST be attributed to ' +
            'group[i] positionally — parallel() guarantees order, whereas the agent-returned name is free text. ' +
            'This is the #465 regression: attributing by returned name silently disabled the halt barrier.',
    );
}

// 2. The halt filter must not go back to matching on the returned name.
if (/group\.find\(\s*\(?\s*g\s*\)?\s*=>\s*g\.repo\s*===\s*r\.repo/.test(src)) {
    errors.push(
        'the halt barrier matches `g.repo === r.repo` again — the exact #465 bug. Agents return ' +
            '"signalxjs/router" while the manifest holds "router", so the filter never matches and the ' +
            'barrier never fires. Attribute by index instead.',
    );
}

// 3. The barrier must still exist. It is edge-wise (#629): an unpublished repo's
//    packages go into `blocked`, and a later repo consuming any of them is held
//    (and its own packages blocked in turn) instead of started.
if (
    !/blocked\.set\(/.test(src) ||
    !/consumesSiblings[^\n]*\.filter\(\s*\(?\s*p\s*\)?\s*=>\s*blocked\.has\(\s*p\s*\)\s*\)/.test(src) ||
    !/held\.push\(/.test(src)
) {
    errors.push(
        'the edge-wise barrier (`blocked.set(...)` for unpublished packages, consumers filtered by ' +
            '`consumesSiblings.filter((p) => blocked.has(p))` and `held.push(...)`) is gone. Without it a ' +
            "repo whose sibling never published is started anyway, and its sibling pins point at versions " +
            'that do not exist on npm.',
    );
}

// 4. The remote preflight must stay — it is what makes a stale local checkout
//    impossible to misreport as missing machinery (the other half of #465).
if (!/phase\('Preflight'\)/.test(src)) {
    errors.push(
        "the 'Preflight' phase is gone. It checks the catalog machinery on each consumer's REMOTE " +
            'default branch before any agent reads a working copy; without it, a stale local checkout ' +
            'is indistinguishable from a repo that never had the machinery (#465).',
    );
}

// 5. The align prompt must keep telling agents to sync the checkout first.
if (!/SYNC THE LOCAL CHECKOUT FIRST/.test(src)) {
    errors.push(
        'the align prompt no longer tells agents to fetch/reset the local checkout before branching. ' +
            'These checkouts drift by many commits; four agents once reported machinery as missing from ' +
            'repos that had carried it for days (#465).',
    );
}

// 6. The Workflow tool's approval dialog rejects CRLF as "control characters" (#629);
//    .gitattributes keeps the file LF — this catches a checkout that lost that.
if (raw.includes('\r')) {
    errors.push(
        'the orchestrator has CR characters (CRLF line endings) — the Workflow approval dialog rejects it. ' +
            'Keep the .gitattributes rule `.claude/workflows/*.mjs text eol=lf` and re-checkout the file.',
    );
}

// 7. `args` has arrived as a JSON string rather than an object (#629); reading
//    `args.onlyTiers` off a string silently ignores it.
if (!/typeof args === 'string'/.test(src)) {
    errors.push("the orchestrator no longer accepts `args` as a JSON string (`typeof args === 'string'` guard, #629).");
}

if (errors.length) {
    console.error('verify:orchestrator FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
}
console.log('verify:orchestrator OK — tier barrier attributes by index, edge-wise hold + preflight + checkout-sync + LF + args guard intact.');
