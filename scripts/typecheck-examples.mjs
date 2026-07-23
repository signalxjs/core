/**
 * Type-check every example against its OWN tsconfig.
 *
 * The examples are the copy-paste surface: a type error there is a
 * user-facing DX bug, and `tsconfig.json` deliberately excludes `examples`
 * (its program is the packages), so nothing else covers them.
 *
 * One program per example, never one shared program — that is what a user
 * gets in their editor, and merging them is actively wrong: several examples
 * declare the same `virtual:*` ambient modules with different types, so a
 * combined program reports collisions that no real consumer would ever see.
 *
 * Two failure modes are guarded, because both are silent:
 *   - an example with no tsconfig would simply not be checked;
 *   - a config whose `include` resolves to nothing exits on TS18003
 *     ("No inputs were found"), which reads like a pass to anyone scanning
 *     CI output. That is exactly how the examples went unchecked (#456).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const examplesDir = join(repoRoot, 'examples');

const examples = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(examplesDir, name, 'package.json')))
    .sort();

if (examples.length === 0) {
    console.error('[typecheck:examples] no examples found — did the layout change?');
    process.exit(1);
}

const failures = [];

for (const name of examples) {
    const config = join(examplesDir, name, 'tsconfig.json');
    if (!existsSync(config)) {
        console.error(`✗ ${name}: no tsconfig.json — it would go unchecked. Add one.`);
        failures.push(name);
        continue;
    }

    try {
        execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', config], {
            cwd: repoRoot,
            stdio: 'pipe',
            encoding: 'utf-8',
            shell: process.platform === 'win32'
        });
        console.log(`✓ ${name}`);
    } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        console.error(`✗ ${name}`);
        console.error(output.trimEnd());
        if (output.includes('TS18003')) {
            console.error(
                `  ↑ this config checked NOTHING. Its include/exclude resolve to an ` +
                `empty program — most likely it extends the root config and inherited ` +
                `its "exclude": ["examples"], which excludes the example's own sources. ` +
                `Override "exclude" locally.`
            );
        }
        failures.push(name);
    }
}

if (failures.length > 0) {
    console.error(`\n[typecheck:examples] FAILED: ${failures.join(', ')}`);
    process.exit(1);
}

console.log(`\n[typecheck:examples] ${examples.length} examples type-check clean.`);
