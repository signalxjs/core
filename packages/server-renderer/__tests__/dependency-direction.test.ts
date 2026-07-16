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
        const NODE_IMPORT = /(?:import\s[^;]*?from\s*|export\s[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]node:/;
        const offenders = collectTsFiles(join(pkgRoot, 'src'))
            .filter((file) => !file.endsWith('node.ts'))
            .filter((file) => NODE_IMPORT.test(readFileSync(file, 'utf-8')));
        expect(offenders).toEqual([]);
    });
});

describe('@sigx/server-renderer/client/scheduler stays runtime-free', () => {
    // The whole point of the scheduler entry is that a page with only
    // deferred islands executes ZERO renderer code at load: the executor is
    // reachable exclusively through loadHydrationCore()'s dynamic import.
    // This test walks the scheduler's STATIC import closure (dynamic
    // `import()` is the boundary) and fails on any sigx-family value import
    // — the complement of the no-ignore size-limit entry, catching the
    // regression at test time instead of at the bundle check.
    const VALUE_IMPORT_FROM =
        /(?:^|\n)\s*(?:import|export)\s+(?!type[\s{])[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

    function staticValueImports(file: string): string[] {
        const source = readFileSync(file, 'utf-8');
        const specs: string[] = [];
        for (const match of source.matchAll(VALUE_IMPORT_FROM)) {
            specs.push((match[1] ?? match[2])!);
        }
        return specs;
    }

    function resolveRelative(fromFile: string, spec: string): string {
        // Source-relative specifiers may carry a .js extension (ESM style);
        // the file on disk is .ts either way.
        const base = join(fromFile, '..', spec.replace(/\.js$/, ''));
        return base.endsWith('.ts') ? base : `${base}.ts`;
    }

    it('the static import closure of scheduler.ts contains no sigx-family value import', () => {
        const entry = join(pkgRoot, 'src', 'client', 'scheduler.ts');
        const seen = new Set<string>([entry]);
        const queue = [entry];
        const offenders: string[] = [];

        while (queue.length > 0) {
            const file = queue.pop()!;
            for (const spec of staticValueImports(file)) {
                if (spec === 'sigx' || spec.startsWith('sigx/') || spec.startsWith('@sigx/')) {
                    offenders.push(`${file} → ${spec}`);
                } else if (spec.startsWith('.')) {
                    const resolved = resolveRelative(file, spec);
                    if (!seen.has(resolved)) {
                        seen.add(resolved);
                        queue.push(resolved);
                    }
                }
            }
        }

        expect(offenders).toEqual([]);
        // Sanity: the closure actually covers the eager surface (a broken
        // regex that matches nothing would green-light anything).
        const names = [...seen].map((f) => f.split(/[\\/]/).pop());
        expect(names).toContain('plugin-registry.ts');
        expect(names).toContain('chunk-loader.ts');
        expect(names).toContain('registry.ts');
    });
});
