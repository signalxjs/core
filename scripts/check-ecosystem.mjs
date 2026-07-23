#!/usr/bin/env node
/**
 * check-ecosystem.mjs — CI guard (`pnpm verify:ecosystem`) for `docs/ecosystem.json`.
 *
 * The manifest is the single source of truth for which repos consume sigx core and in
 * what ORDER they are aligned and released after a core release. It is read by
 * `release.yml`'s consumer fan-out, by `docs/ecosystem-release.md`, and by the
 * orchestrator in `.github/workflows-ai/`. A stale manifest silently mis-orders a
 * release — exactly how the hardcoded fan-out list in `release.yml` came to be missing
 * six live consumers. This script makes that failure loud instead.
 *
 * It checks, offline:
 *   1. `corePackages` matches the publishable packages in THIS repo, exactly. A new
 *      core package that nobody added here would otherwise never reach a consumer's
 *      catalog (`@sigx/serialize`, `@sigx/cloudflare`, `@sigx/vercel` and
 *      `@sigx/netlify` all shipped before the sync tooling learned about them).
 *   2. Repo names and published package names are unique across the manifest.
 *   3. Every `consumesSiblings` entry is published by some repo in the manifest.
 *   4. Tiers are a valid topological order: a consumer's tier is strictly greater
 *      than the tier of every repo publishing a package it consumes. This is what
 *      makes "release tier N, then tier N+1" correct rather than folklore.
 *   5. Every `consumesCore` entry is a real core package.
 *
 * With `--remote` it additionally hits the GitHub API to confirm each repo exists and
 * actually publishes what the manifest claims. Not run in CI (network + rate limits) —
 * use it when editing the manifest by hand.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'docs', 'ecosystem.json');
const remote = process.argv.includes('--remote');
const errors = [];

/** The packages this repo actually publishes, read from disk. */
function readCorePackages() {
    const dir = join(repoRoot, 'packages');
    const names = [];
    for (const entry of readdirSync(dir)) {
        const pj = join(dir, entry, 'package.json');
        if (!existsSync(pj)) continue;
        const pkg = JSON.parse(readFileSync(pj, 'utf8'));
        if (pkg.private) continue;
        names.push(pkg.name);
    }
    return names;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const { corePackages, consumers } = manifest;

if (!Array.isArray(corePackages) || !Array.isArray(consumers)) {
    console.error('check-ecosystem: docs/ecosystem.json needs `corePackages` and `consumers` arrays.');
    process.exit(2);
}

// 1. corePackages == what this repo publishes.
const onDisk = readCorePackages();
for (const name of onDisk) {
    if (!corePackages.includes(name)) {
        errors.push(`corePackages is missing "${name}" — this repo publishes it. Add it here AND to CORE_PACKAGES in repo-template's scripts/sync-core.mjs + scripts/check-catalog.mjs, or consumers will never pin it.`);
    }
}
for (const name of corePackages) {
    if (!onDisk.includes(name)) {
        errors.push(`corePackages lists "${name}", which this repo no longer publishes.`);
    }
}

// 2. Uniqueness.
const seenRepos = new Set();
const publisherOf = new Map(); // npm package name -> consumer entry
for (const c of consumers) {
    if (seenRepos.has(c.repo)) errors.push(`duplicate repo entry "${c.repo}".`);
    seenRepos.add(c.repo);
    if (typeof c.tier !== 'number' || c.tier < 1) {
        errors.push(`${c.repo}: tier must be a number >= 1 (got ${JSON.stringify(c.tier)}).`);
    }
    for (const pkg of c.publishes ?? []) {
        if (publisherOf.has(pkg)) {
            errors.push(`"${pkg}" is claimed by both ${publisherOf.get(pkg).repo} and ${c.repo}.`);
        }
        publisherOf.set(pkg, c);
    }
    if ((c.publishes ?? []).length === 0 && !c.private) {
        errors.push(`${c.repo}: publishes nothing but is not marked \`"private": true\`.`);
    }
}

// 3 + 4. Sibling deps resolve, and tiers are a valid topological order.
for (const c of consumers) {
    for (const pkg of c.consumesSiblings ?? []) {
        const producer = publisherOf.get(pkg);
        if (!producer) {
            errors.push(`${c.repo} consumes sibling "${pkg}", which no repo in the manifest publishes. Add the producing repo, or (for a lockstep repo like lynx) add "${pkg}" to its \`publishes\`.`);
            continue;
        }
        if (producer.repo === c.repo) continue; // intra-repo, ordered by its own publish script
        if (producer.tier >= c.tier) {
            errors.push(`tier order violated: ${c.repo} (tier ${c.tier}) consumes "${pkg}" from ${producer.repo} (tier ${producer.tier}). A consumer must sit in a strictly LATER tier than its producer.`);
        }
    }
    // 5. consumesCore entries are real.
    for (const pkg of c.consumesCore ?? []) {
        if (!corePackages.includes(pkg)) {
            errors.push(`${c.repo} lists core dep "${pkg}", which is not a core package.`);
        }
    }
}

// Optional: confirm the repos exist and ship what we claim.
if (remote) {
    for (const c of consumers) {
        let dirs;
        try {
            const out = execFileSync(
                'gh',
                ['api', `repos/signalxjs/${c.repo}/contents/packages`, '--jq', '.[]|select(.type=="dir")|.name'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
            );
            dirs = out.split('\n').filter(Boolean);
        } catch {
            errors.push(`--remote: cannot read signalxjs/${c.repo}/packages (repo missing, renamed, or gh unauthenticated).`);
            continue;
        }
        const shipped = new Set();
        for (const d of dirs) {
            try {
                const raw = execFileSync(
                    'gh',
                    ['api', `repos/signalxjs/${c.repo}/contents/packages/${d}/package.json`, '--jq', '.content'],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
                );
                const pkg = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
                if (!pkg.private) shipped.add(pkg.name);
            } catch {
                /* a packages/ subdir with no package.json is fine */
            }
        }
        for (const pkg of c.publishes ?? []) {
            if (!shipped.has(pkg)) errors.push(`--remote: ${c.repo} does not publish "${pkg}".`);
        }
        // Only repos NOT flagged as a subset must list everything they ship.
        if (!c.publishesIsSubset) {
            for (const pkg of shipped) {
                if (!(c.publishes ?? []).includes(pkg)) {
                    errors.push(`--remote: ${c.repo} publishes "${pkg}", missing from its \`publishes\` list.`);
                }
            }
        }
    }
}

if (errors.length) {
    console.error('verify:ecosystem FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
}

const tiers = [...new Set(consumers.map((c) => c.tier))].sort((a, b) => a - b);
console.log(
    `verify:ecosystem OK — ${corePackages.length} core packages, ${consumers.length} consumers across ${tiers.length} tiers (${tiers.join(', ')}).`,
);
