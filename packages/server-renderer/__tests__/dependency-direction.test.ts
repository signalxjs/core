/**
 * Architectural guard: the dependency edge between the SSR core and the islands
 * strategy pack stays ONE-WAY.
 *
 * `@sigx/server-renderer` is a strategy-agnostic plugin platform;
 * `@sigx/ssr-islands` is just the first-party reference pack that rides the
 * public plugin API. The renderer must never depend on, import, or name the
 * islands pack — otherwise islands stops being a drop-in equal of any
 * third-party pack (resumability, progressive enhancement, …). Co-locating both
 * in this monorepo makes the shortcut tempting; this test makes the boundary
 * structural rather than conventional.
 *
 * See the `client-bundle` test in packages/sigx for the complementary guard that
 * the `client:*` directive vocabulary never re-enters the core bundle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(fileURLToPath(import.meta.url), '..', '..');
const ISLANDS = '@sigx/ssr-islands';

function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectTsFiles(full));
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

describe('@sigx/server-renderer dependency direction', () => {
    it('does not declare any dependency on @sigx/ssr-islands', () => {
        const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as Record<
            string,
            Record<string, string> | undefined
        >;
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            expect(Object.keys(pkg[field] ?? {})).not.toContain(ISLANDS);
        }
    });

    it('no source file imports or references @sigx/ssr-islands', () => {
        const offenders = collectTsFiles(join(pkgRoot, 'src')).filter((file) =>
            readFileSync(file, 'utf-8').includes(ISLANDS)
        );
        expect(offenders).toEqual([]);
    });
});

describe('@sigx/server-renderer edge portability (rfc-ssr-platform §2.3)', () => {
    it("only the ./node entry imports node: builtins — ./server and '.' are WinterCG-clean", () => {
        const NODE_IMPORT = /(?:import\s[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]node:/;
        const offenders = collectTsFiles(join(pkgRoot, 'src'))
            .filter((file) => !file.endsWith('node.ts'))
            .filter((file) => NODE_IMPORT.test(readFileSync(file, 'utf-8')));
        expect(offenders).toEqual([]);
    });
});
