#!/usr/bin/env node

/**
 * SignalX - Publish Script
 *
 * Publishes all packages in this repo to npm in dependency order.
 *
 * Usage:
 *   node scripts/publish.js [--dry-run] [--tag <tag>] [--provenance]
 *
 * After the wave, every package's registry dist-tag (`latest`, or `--tag`)
 * is read back with `npm view` and compared to the local version; any
 * mismatch fails the run (#363). A step that shows green while `npm view`
 * disagrees is how a partial 1.0.0 would slip out unnoticed — and a broken
 * publish cannot be unpublished after 72 h.
 *
 * Options:
 *   --dry-run     Show what would be published without actually publishing
 *                 (skips the post-wave registry verification too)
 *   --tag         Publish with a specific tag (e.g., beta, next)
 *   --provenance  Attach an npm provenance attestation. Requires running in a
 *                 GitHub Actions workflow with `permissions: id-token: write`.
 *
 * Environment Variables:
 *   NPM_TOKEN    npm automation token. Optional — only needed for local
 *                publishing or as a fallback. CI uses npm trusted publishing
 *                (OIDC) instead, configured per-package on npmjs.com.
 *                Create at: https://www.npmjs.com/settings/<username>/tokens
 *                ("Automation" type for CI use).
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// The one list of publishable packages, in dependency order — shared with
// verify-pack.js so what ships and what gets pack-verified can never drift
// again (#363).
import { PACKAGES, rootDir, assertPackagesComplete } from './packages.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tagIndex = args.indexOf('--tag');
const tag = tagIndex !== -1 ? args[tagIndex + 1] : null;
const provenance = args.includes('--provenance');

// NPM token support for CI/CD (avoids 2FA prompts)
const NPM_TOKEN = process.env.NPM_TOKEN;
let npmrcCreated = false;
let originalNpmrc = null;
const npmrcPath = join(homedir(), '.npmrc');

function setupNpmToken() {
    if (!NPM_TOKEN) return;

    console.log('🔑 Using NPM_TOKEN for authentication\n');

    // Backup existing .npmrc if present
    if (existsSync(npmrcPath)) {
        originalNpmrc = readFileSync(npmrcPath, 'utf-8');
    }

    // Write/update token to .npmrc (always update if NPM_TOKEN is set)
    const tokenLine = `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`;
    if (originalNpmrc) {
        // Replace existing token line or append
        if (originalNpmrc.includes('//registry.npmjs.org/:_authToken=')) {
            const updated = originalNpmrc.replace(
                /\/\/registry\.npmjs\.org\/:_authToken=.*/,
                tokenLine
            );
            writeFileSync(npmrcPath, updated);
        } else {
            writeFileSync(npmrcPath, originalNpmrc + '\n' + tokenLine);
        }
        npmrcCreated = true;
    } else {
        writeFileSync(npmrcPath, tokenLine);
        npmrcCreated = true;
    }
}

function cleanupNpmToken() {
    if (!npmrcCreated) return;

    if (originalNpmrc) {
        writeFileSync(npmrcPath, originalNpmrc);
    } else {
        unlinkSync(npmrcPath);
    }
    npmrcCreated = false;
}

let signalsRegistered = false;
function registerCleanupHandlers() {
    if (signalsRegistered) return;
    signalsRegistered = true;

    const handle = (signal) => {
        try {
            cleanupNpmToken();
        } catch (err) {
            console.error('⚠️  Failed to clean up ~/.npmrc on exit:', err);
        }
        // Mirror the conventional shell exit code (128 + signal number) for SIGINT/SIGTERM.
        const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
        process.exit(code);
    };

    process.on('SIGINT', () => handle('SIGINT'));
    process.on('SIGTERM', () => handle('SIGTERM'));
    process.on('uncaughtException', (err) => {
        console.error('💥 Uncaught exception:', err);
        handle('uncaughtException');
    });
    process.on('unhandledRejection', (err) => {
        console.error('💥 Unhandled rejection:', err);
        handle('unhandledRejection');
    });
}

function getPackageInfo(packagePath) {
    const packageJsonPath = join(rootDir, packagePath, 'package.json');
    if (!existsSync(packageJsonPath)) {
        return null;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return {
        name: packageJson.name,
        version: packageJson.version,
        path: packagePath,
    };
}

/**
 * What the registry currently serves for `name` under `distTag` — or null
 * when the package/tag is unknown (never published, or `npm view` failed).
 */
function publishedVersion(name, distTag) {
    try {
        const result = execSync(`npm view ${name} dist-tags.${distTag}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return result || null;
    } catch {
        return null;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Post-wave verification: the registry must agree with the local version for
 * EVERY package in the list — published or skipped-as-already-published alike.
 * A freshly published version can take a few seconds to show up in `npm view`,
 * so each package gets a handful of retries before it counts as a mismatch.
 * Returns the list of mismatches (empty = the wave is verified).
 */
async function verifyPublishedVersions(distTag, { attempts = 5, delayMs = 5000 } = {}) {
    const mismatches = [];
    for (const packagePath of PACKAGES) {
        const pkg = getPackageInfo(packagePath);
        if (!pkg) continue;
        let seen = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            seen = publishedVersion(pkg.name, distTag);
            if (seen === pkg.version) break;
            if (attempt < attempts) await sleep(delayMs);
        }
        if (seen === pkg.version) {
            console.log(`   ✅ ${pkg.name}@${distTag} = ${seen}`);
        } else {
            console.error(`   ❌ ${pkg.name}@${distTag} = ${seen ?? '(not found)'}  — local is ${pkg.version}`);
            mismatches.push({ name: pkg.name, expected: pkg.version, actual: seen });
        }
    }
    return mismatches;
}

function isAlreadyPublished(name, version) {
    try {
        const result = execSync(`npm view ${name}@${version} version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        return result === version;
    } catch {
        return false;
    }
}

function publishPackage(pkg) {
    const fullPath = join(rootDir, pkg.path);
    // Use pnpm publish to automatically convert workspace:^ to actual versions
    const publishCmd = dryRun
        ? 'pnpm pack --dry-run'
        : `pnpm publish --access public --no-git-checks${tag ? ` --tag ${tag}` : ''}${provenance ? ' --provenance' : ''}`;

    console.log(`\n📦 ${dryRun ? 'Would publish' : 'Publishing'}: ${pkg.name}@${pkg.version}`);
    console.log(`   Path: ${pkg.path}`);

    // Skip if already published
    if (!dryRun && isAlreadyPublished(pkg.name, pkg.version)) {
        console.log(`   ⏭️  Skipped: ${pkg.name}@${pkg.version} (already published)`);
        return 'skipped';
    }

    try {
        execSync(publishCmd, {
            cwd: fullPath,
            stdio: 'inherit'
        });
        console.log(`   ✅ ${dryRun ? 'Ready' : 'Published'}: ${pkg.name}@${pkg.version}`);
        return 'published';
    } catch (error) {
        console.error(`   ❌ Failed: ${pkg.name}`);
        return 'failed';
    }
}

async function main() {
    console.log('🚀 SignalX Publisher');
    console.log('================================');

    if (dryRun) {
        console.log('🔍 DRY RUN MODE - No packages will be published\n');
    }

    if (tag) {
        console.log(`🏷️  Publishing with tag: ${tag}\n`);
    }

    if (provenance) {
        console.log('🔏 Provenance attestations enabled\n');
    }

    // Register signal handlers BEFORE writing the token so a Ctrl+C between
    // setupNpmToken() and the cleanup in `finally` still removes the token.
    registerCleanupHandlers();

    // Setup npm token if provided
    setupNpmToken();

    // Trusted publishing (npm OIDC) acquires a token at publish time, not before.
    // Skip the whoami precheck in that mode — it would fail because no token is
    // present yet. ACTIONS_ID_TOKEN_REQUEST_TOKEN is set by GitHub Actions when
    // a job has `permissions: id-token: write`.
    const isTrustedPublishing = !NPM_TOKEN && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (isTrustedPublishing) {
        console.log('🔐 Trusted publishing (OIDC) — skipping npm whoami precheck\n');
    } else {
        try {
            const whoami = execSync('npm whoami', { encoding: 'utf-8' }).trim();
            console.log(`👤 Logged in as: ${whoami}\n`);
        } catch {
            console.error('❌ Not logged in to npm. Run: npm login');
            console.error('   Or set NPM_TOKEN environment variable');
            throw new Error('npm login required');
        }
    }

    // Refuse to ship a list that disagrees with packages/* on disk: a package
    // missing from the list would silently never publish.
    assertPackagesComplete();

    // Build all packages first
    console.log('🔨 Building all packages...');
    try {
        execSync('pnpm run build', { cwd: rootDir, stdio: 'inherit' });
        console.log('✅ Build complete\n');
    } catch {
        throw new Error('Build failed');
    }

    // Publish packages in order
    const results = { published: [], skipped: [], failed: [] };

    for (const packagePath of PACKAGES) {
        const pkg = getPackageInfo(packagePath);
        if (!pkg) {
            console.warn(`⚠️  Skipping ${packagePath}: package.json not found`);
            continue;
        }

        const result = publishPackage(pkg);
        if (result === 'published') {
            results.published.push(pkg.name);
        } else if (result === 'skipped') {
            results.skipped.push(pkg.name);
        } else {
            results.failed.push(pkg.name);
            if (!dryRun) {
                console.error('\n⚠️  Stopping due to publish failure');
                break;
            }
        }
    }

    // Summary
    console.log('\n================================');
    console.log('📊 Summary');
    console.log('================================');
    if (results.published.length > 0) {
        console.log(`✅ ${dryRun ? 'Ready' : 'Published'}: ${results.published.length} packages`);
        console.log(`   ${results.published.join(', ')}`);
    }
    if (results.skipped.length > 0) {
        console.log(`⏭️  Skipped: ${results.skipped.length} packages (already published)`);
    }
    if (results.failed.length > 0) {
        console.log(`❌ Failed: ${results.failed.length} packages`);
        console.log(`   ${results.failed.join(', ')}`);
    }

    if (!dryRun && results.failed.length === 0) {
        console.log('\n🎉 All packages up to date!');
    }

    // Surface partial-publish failures as a non-zero exit so CI doesn't
    // mark a broken release as success — npm rejects, GH release publishes
    // anyway, npm-vs-tag drift, etc.
    if (results.failed.length > 0) {
        process.exitCode = 1;
        return;
    }

    // Post-wave verification (#363): don't trust the publish loop's own
    // accounting — ask the registry. Every package, including the ones
    // skipped as already published, must serve the local version under the
    // dist-tag this wave targeted. Skipped for dry runs: nothing was shipped.
    if (dryRun) {
        console.log('\n🔍 DRY RUN — skipping post-wave registry verification');
        return;
    }
    const distTag = tag ?? 'latest';
    console.log(`\n🔎 Verifying the registry serves every package at its local version (dist-tag: ${distTag})...`);
    const mismatches = await verifyPublishedVersions(distTag);
    if (mismatches.length > 0) {
        console.error(`\n❌ Post-wave verification failed for ${mismatches.length} package(s):`);
        for (const m of mismatches) {
            console.error(`   ${m.name}: expected ${m.expected}, registry serves ${m.actual ?? '(nothing)'}`);
        }
        console.error('   The wave is incomplete or the dist-tag did not move — investigate before tagging a GitHub release.');
        process.exitCode = 1;
        return;
    }
    console.log(`✅ Registry verified: ${PACKAGES.length} packages at their local versions`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        cleanupNpmToken();
    });
