#!/usr/bin/env node
/**
 * Git worktree helper for parallel work — the sigx standard.
 *
 * Each worktree is a sibling checkout of the main one (../<name>) on its own
 * branch `<name>`, with dependencies installed, so multiple changes (and agent
 * sessions) can run side by side without switching branches in place.
 *
 * Usage:
 *   pnpm wt new <name> [--from <branch>]
 *   pnpm wt list
 *   pnpm wt rm <name> [--force]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT_DIR = path.dirname(REPO_ROOT); // worktrees live as siblings of the main checkout

// ── small utils ────────────────────────────────────────────────────────────

function git(args, opts = {}) {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
}

/** Run a shell command string (cross-platform: resolves pnpm.cmd on Windows). */
function sh(command, opts = {}) {
    return spawnSync(command, { shell: true, encoding: 'utf8', ...opts });
}

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i++;
            }
        } else {
            positional.push(a);
        }
    }
    return { positional, flags };
}

/** Paths of every registered worktree, via porcelain output. The main checkout is always first. */
function worktreePaths() {
    return git(['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim());
}

/** Absolute path of the primary (main) checkout, regardless of where the script runs. */
function mainCheckout() {
    return path.resolve(worktreePaths()[0]);
}

/** Reject names that could escape ../<name> as a path or be invalid as a git branch. */
function assertSafeName(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
        die(`Invalid name '${name}' — use letters, digits, '.', '_', '-' only (no slashes or '..').`);
    }
}

function die(msg) {
    console.error(msg);
    process.exit(1);
}

// ── commands ───────────────────────────────────────────────────────────────

function cmdNew(positional, flags) {
    const name = positional[0];
    if (!name) die('Usage: pnpm wt new <name> [--from <branch>]');
    assertSafeName(name);

    const worktree = path.join(PARENT_DIR, name);
    if (existsSync(worktree)) die(`Path already exists: ${worktree}`);

    // 1. Create the worktree. Always create a NEW branch `name` (a branch can't be
    //    checked out in two worktrees), optionally based on `--from` (else HEAD).
    console.log(`Creating worktree at ${worktree}…`);
    const addArgs = ['worktree', 'add', '-b', name, worktree];
    if (flags.from && flags.from !== true) addArgs.push(String(flags.from));
    git(addArgs, { stdio: 'inherit' });

    // 2. Install deps (pnpm hardlinks from the global store — fast).
    console.log('Installing dependencies (pnpm install)…');
    const install = sh('pnpm install', { cwd: worktree, stdio: 'inherit' });
    if (install.status !== 0) console.warn('  ⚠ pnpm install exited non-zero — check output above.');

    console.log(`\n✓ Worktree '${name}' ready.\nNext:`);
    console.log(`  cd "${worktree}"`);
    console.log('  pnpm typecheck && pnpm test   # verify the checkout works');
    console.log('  # …or launch an agent session from that directory for isolated parallel work.');
}

function cmdList() {
    const main = mainCheckout();
    for (const wt of worktreePaths()) {
        console.log(`${wt}${path.resolve(wt) === main ? '  (main)' : ''}`);
    }
}

function cmdRm(positional, flags) {
    const name = positional[0];
    if (!name) die('Usage: pnpm wt rm <name> [--force]');
    assertSafeName(name);
    const worktree = path.join(PARENT_DIR, name);
    if (path.resolve(worktree) === mainCheckout()) die('Refusing to remove the main checkout.');

    const args = ['worktree', 'remove', worktree];
    if (flags.force) args.push('--force');
    try {
        git(args, { stdio: 'inherit' });
    } catch {
        // On Windows, git often fails to delete pnpm's node_modules (symlinks/junctions
        // → "Function not implemented"). Finish the deletion ourselves and prune.
        if (existsSync(path.join(worktree, '.git')) && !flags.force) {
            die(`git refused to remove '${name}' (dirty?) — re-run with --force if you mean it.`);
        }
        console.warn('  ⚠ git could not fully delete the directory — removing it directly…');
        rmSync(worktree, { recursive: true, force: true });
    }
    git(['worktree', 'prune']);
    console.log(`✓ Removed worktree '${name}'.`);
}

// ── entry ──────────────────────────────────────────────────────────────────

const [sub, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

switch (sub) {
    case 'new':
        cmdNew(positional, flags);
        break;
    case 'list':
        cmdList();
        break;
    case 'rm':
    case 'remove':
        cmdRm(positional, flags);
        break;
    default:
        die('Usage: pnpm wt <new|list|rm> …\n' +
            '  pnpm wt new <name> [--from <branch>]\n' +
            '  pnpm wt list\n' +
            '  pnpm wt rm <name> [--force]');
}
