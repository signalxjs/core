/**
 * Architectural guard (#416): the resume pack rides ONLY the public pack
 * contract of `@sigx/server-renderer` — no underscore `SSRContext` members,
 * no `/internals` imports. This is what makes the "drop-in equal of any
 * third-party pack" claim structural rather than aspirational: everything
 * this pack does, an out-of-tree pack can do with the same typed imports.
 *
 * Mirrors server-renderer's dependency-direction guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(fileURLToPath(import.meta.url), '..', '..', 'src');

function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectTsFiles(full));
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

describe('@sigx/resume rides only the public pack contract (#416)', () => {
    it('no source file imports from an /internals entry', () => {
        // `sigx/internals` / `@sigx/*/internals` are explicitly
        // change-without-notice surface — a pack that needs something from
        // there needs the export promoted, not the import.
        const INTERNALS_IMPORT = /from\s*['"][^'"]*\/internals['"]/;
        const offenders = collectTsFiles(srcRoot).filter((file) =>
            INTERNALS_IMPORT.test(readFileSync(file, 'utf-8'))
        );
        expect(offenders).toEqual([]);
    });

    it('no source file touches an underscore SSRContext member', () => {
        // The public accessors: currentComponentId(), boundaries(),
        // getBoundary(), createSSRContext({ appContext }),
        // registerSerializedState(). The underscore fields are @internal.
        const PRIVATE_MEMBER = /\._(componentStack|boundaries|appContext|asyncResults|unflushedAsyncKeys|unflushedBoundaries|phase|pluginData)\b/;
        const offenders = collectTsFiles(srcRoot).filter((file) =>
            PRIVATE_MEMBER.test(readFileSync(file, 'utf-8'))
        );
        expect(offenders).toEqual([]);
    });
});
