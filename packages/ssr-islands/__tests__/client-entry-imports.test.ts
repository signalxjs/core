/**
 * Architectural guard: `@sigx/ssr-islands/client` stays on the eager,
 * runtime-free surface.
 *
 * The whole point of the lazy hydration core (#293) is that a page whose
 * islands are all deferred executes ZERO sigx runtime at load. That only
 * holds if the light client entry's STATIC import closure (dynamic
 * `import()` is the boundary) never reaches a sigx-family value import —
 * including `@sigx/server-renderer/client`, the heavy barrel: only the
 * `/client/scheduler` entry is allowed. Complements the no-ignore
 * size-limit entry, catching the regression at test time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(fileURLToPath(import.meta.url), '..', '..');

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
    const base = join(fromFile, '..', spec.replace(/\.js$/, ''));
    return base.endsWith('.ts') ? base : `${base}.ts`;
}

function isHeavy(spec: string): boolean {
    if (spec === 'sigx' || spec.startsWith('sigx/')) return true;
    if (spec.startsWith('@sigx/')) {
        // The runtime-free scheduler entry is the ONE allowed dependency.
        return spec !== '@sigx/server-renderer/client/scheduler';
    }
    return false;
}

describe('@sigx/ssr-islands/client stays runtime-free', () => {
    it('the static import closure of client/index.ts reaches no sigx runtime', () => {
        const entry = join(pkgRoot, 'src', 'client', 'index.ts');
        const seen = new Set<string>([entry]);
        const queue = [entry];
        const offenders: string[] = [];

        while (queue.length > 0) {
            const file = queue.pop()!;
            for (const spec of staticValueImports(file)) {
                if (isHeavy(spec)) {
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
        // Sanity: the walk actually covered the eager surface.
        const names = [...seen].map((f) => f.split(/[\\/]/).pop());
        expect(names).toContain('hydrate-islands.ts');
        expect(names).toContain('registry.ts');
        // ...and the lazy hooks module stayed OUTSIDE the closure.
        expect(names).not.toContain('plugin-hooks.ts');
    });
});
