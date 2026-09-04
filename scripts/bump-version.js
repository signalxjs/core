#!/usr/bin/env node

/**
 * SignalX - Bump every publishable package to the same version
 *
 * Usage:
 *   node scripts/bump-version.js <patch|minor|major|X.Y.Z[-pre]> [--dry-run]
 *   node scripts/bump-version.js --help
 *
 * Exactly one bump argument is accepted: a bump type, or an exact semver
 * (prereleases like `1.0.0-rc.0` included; build metadata `+sha` is NOT —
 * npm strips it on publish, so `isAlreadyPublished` and publish.js's
 * post-wave gate would compare `1.0.0+sha` against a registry `1.0.0` and
 * fail every package). ANYTHING else — a typo, an
 * unknown flag, no argument — prints usage and exits 2 without touching a
 * file. It used to default to `patch` with a `switch` fallthrough, so
 * `node scripts/bump-version.js --help` bumped all 14 packages (#363, #629).
 *
 * Options:
 *   --dry-run   Print the old → new version per package; write nothing.
 *   -h, --help  Print this usage and exit 0.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');

const BUMP_TYPES = ['patch', 'minor', 'major'];
// semver 2.0.0 core + optional prerelease. No build metadata: the registry
// never stores it, so a `+build` version can never verify after publish.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const USAGE = [
    'Usage: node scripts/bump-version.js <patch|minor|major|X.Y.Z[-pre]> [--dry-run]',
    '',
    '  patch | minor | major   bump every publishable package from its current version',
    '  X.Y.Z[-pre]             set every publishable package to this exact version',
    '                          (prereleases such as 1.0.0-rc.0 are accepted; build',
    '                          metadata like 1.0.0+sha is not — npm strips it on publish)',
    '  --dry-run               print old -> new per package, write nothing',
    '  -h, --help              show this help',
    '',
    'Exactly one bump argument is required; anything else exits 2 without touching a file.',
].join('\n');

/** Parse argv into `{ bumpType, exactVersion, dryRun }`, or throw a usage error. */
function parseArgs(argv) {
    let dryRun = false;
    const positional = [];
    for (const a of argv) {
        if (a === '--help' || a === '-h') return { help: true };
        if (a === '--dry-run') {
            dryRun = true;
            continue;
        }
        positional.push(a);
    }
    if (positional.length !== 1) {
        throw new Error(
            positional.length === 0
                ? 'missing bump argument'
                : `expected exactly one bump argument, got: ${positional.join(' ')}`
        );
    }
    const [arg] = positional;
    if (BUMP_TYPES.includes(arg)) return { bumpType: arg, exactVersion: null, dryRun };
    if (SEMVER_RE.test(arg)) return { bumpType: null, exactVersion: arg, dryRun };
    throw new Error(`unknown bump argument: ${JSON.stringify(arg)}`);
}

/**
 * node-semver's `inc` semantics: bumping a prerelease "releases" it
 * (1.0.0-rc.0 → patch → 1.0.0, not 1.0.1), and the prerelease suffix never
 * survives a bump.
 */
function bumpVersion(version, type) {
    const m = SEMVER_RE.exec(version);
    if (!m) throw new Error(`cannot bump ${JSON.stringify(version)}: not a valid semver`);
    const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const pre = m[4] !== undefined;
    switch (type) {
        case 'major':
            return minor === 0 && patch === 0 && pre ? `${major}.0.0` : `${major + 1}.0.0`;
        case 'minor':
            return patch === 0 && pre ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
        case 'patch':
            return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
        default:
            throw new Error(`unknown bump type: ${JSON.stringify(type)}`);
    }
}

function processPackages(dir, { bumpType, exactVersion, dryRun }) {
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        if (!statSync(fullPath).isDirectory()) continue;
        const pkgPath = join(fullPath, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.private) {
            console.log(`Skipping private package: ${pkg.name}`);
            continue;
        }
        const oldVersion = pkg.version;
        const newVersion = exactVersion ?? bumpVersion(oldVersion, bumpType);
        console.log(`${pkg.name}: ${oldVersion} → ${newVersion}`);
        if (dryRun) continue;
        pkg.version = newVersion;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
    }
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`bump-version: ${err.message}\n`);
        console.error(USAGE);
        process.exit(2);
    }
    if (opts.help) {
        console.log(USAGE);
        process.exit(0);
    }

    if (opts.dryRun) console.log('DRY RUN — nothing will be written\n');
    if (opts.exactVersion) {
        console.log(`Setting all packages to version ${opts.exactVersion}...\n`);
    } else {
        console.log(`Bumping ${opts.bumpType} version for packages...\n`);
    }
    processPackages(packagesDir, opts);
    console.log(opts.dryRun ? '\nDone (dry run — no files written).' : '\nDone!');
}

main();
