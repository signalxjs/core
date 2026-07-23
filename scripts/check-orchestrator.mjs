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
const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*');
    })
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

// 3. The barrier must still exist and still break out of the tier loop.
if (!/haltedAt\s*=\s*\{/.test(src) || !/\bbreak\b/.test(src)) {
    errors.push(
        'the between-tier halt (`haltedAt = {...}` + `break`) is gone. Without it a tier whose repos ' +
            'never published does not stop the tiers below, and their sibling pins point at versions ' +
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

if (errors.length) {
    console.error('verify:orchestrator FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
}
console.log('verify:orchestrator OK — tier barrier attributes by index, halt + preflight + checkout-sync intact.');
