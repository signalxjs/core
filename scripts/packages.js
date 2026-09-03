/**
 * SignalX - The one list of publishable packages
 *
 * Shared by `scripts/publish.js` (what gets published, in this order) and
 * `scripts/verify-pack.js` (what gets pack-verified on every PR). One list so
 * the two can never drift again: for months verify-pack listed 11 of the 14
 * packages publish.js shipped, and the three it skipped (`resume`, `cache`,
 * `server`) were exactly the ones that sat out a wave (#363, #300).
 *
 * Order matters: dependency order, dependencies first — publish.js walks it
 * top to bottom, and a package must land on the registry before anything
 * that depends on it does.
 *
 * `assertPackagesComplete()` cross-checks this list against every non-private
 * `packages/*` on disk, so adding a package without listing it here fails
 * both scripts loudly instead of silently shipping (or verifying) 13 of 14.
 *
 * Other SignalX packages (router, store, ssg, daisyui, runtime-terminal, …)
 * live in their own repos under https://github.com/signalxjs and are
 * published from there — see docs/ecosystem.json.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(__dirname, '..');

export const PACKAGES = [
    // Zero dependencies — the base of the stack, so it publishes first.
    'packages/serialize',
    'packages/reactivity',
    'packages/runtime-core',
    'packages/runtime-dom',
    'packages/sigx',
    'packages/server-renderer',
    'packages/ssr-islands',
    'packages/resume',
    'packages/cache',
    'packages/server',
    'packages/vite',
    'packages/cloudflare',
    'packages/vercel',
    'packages/netlify',
];

/**
 * Throw if `PACKAGES` and the non-private `packages/*` directories on disk
 * disagree in either direction.
 */
export function assertPackagesComplete() {
    const packagesDir = join(rootDir, 'packages');
    const onDisk = [];
    for (const entry of readdirSync(packagesDir)) {
        const pj = join(packagesDir, entry, 'package.json');
        if (!existsSync(pj)) continue;
        const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
        if (pkg.private) continue;
        onDisk.push(`packages/${entry}`);
    }
    const listed = new Set(PACKAGES);
    const missing = onDisk.filter((p) => !listed.has(p));
    const stale = PACKAGES.filter((p) => !existsSync(join(rootDir, p, 'package.json')));
    const problems = [];
    if (missing.length) {
        problems.push(`publishable on disk but not in scripts/packages.js PACKAGES: ${missing.join(', ')}`);
    }
    if (stale.length) {
        problems.push(`listed in scripts/packages.js PACKAGES but not on disk: ${stale.join(', ')}`);
    }
    if (problems.length) {
        throw new Error(`scripts/packages.js is out of sync with packages/*:\n  - ${problems.join('\n  - ')}`);
    }
}

/**
 * The dependency fields a published manifest must have fully resolved.
 * `devDependencies` are not published, so they are deliberately not checked.
 */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Find every dependency range in a (packed) package.json that still carries a
 * pnpm workspace protocol (`workspace:^`, `workspace:*`) or catalog reference
 * (`catalog:`, `catalog:name`). `pnpm pack` / `pnpm publish` rewrite those to
 * concrete versions; `npm pack` does not, and a manifest that reaches the
 * registry with one is uninstallable for every consumer.
 *
 * Returns `[{ field, name, range }]` — empty when the manifest is clean.
 */
export function findUnresolvedRanges(pkgJson) {
    const found = [];
    for (const field of DEPENDENCY_FIELDS) {
        const deps = pkgJson[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const [name, range] of Object.entries(deps)) {
            if (typeof range === 'string' && /\b(workspace|catalog):/.test(range)) {
                found.push({ field, name, range });
            }
        }
    }
    return found;
}
