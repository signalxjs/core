/**
 * @vitest-environment node
 *
 * `@sigx/vite/assets` is reachable from a runtime that has no `node:` builtins
 * and no `process` (#486).
 *
 * `collectAssets` is a pure function over a parsed manifest, but it used to
 * share a module with the dev request handler, whose top level imports
 * `node:fs/promises` and `node:path`. A workerd/edge entry that wanted
 * per-route asset resolution therefore could not import it at all, and the
 * only way to ship was to hand-port the function into the app.
 *
 * The guard is on the SOURCE (and, when built, the dist): an import added to
 * this entry later is what would silently re-break it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectAssets, type ViteManifest } from '../src/assets';

const SRC = fileURLToPath(new URL('../src/assets.ts', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/assets.js', import.meta.url));

/** Every module specifier this file imports, static or dynamic. */
function importsOf(code: string): string[] {
    const out: string[] = [];
    for (const m of code.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
    for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
    return out;
}

describe('@sigx/vite/assets — edge-clean entry (#486)', () => {
    it('the source imports nothing at all', () => {
        expect(importsOf(readFileSync(SRC, 'utf-8'))).toEqual([]);
    });

    // The source assertion above is the gate — `@sigx/vite` builds with plain
    // `tsc`, so dist is a 1:1 transpile with no bundling step that could
    // introduce an import. This is the belt-and-braces check on the artifact
    // consumers actually load; it needs `pnpm build`, which the `test` job runs
    // and the `coverage` job does not, so it reports as skipped there rather
    // than failing on a missing file.
    it.skipIf(!existsSync(DIST))('the built entry imports nothing at all', () => {
        expect(importsOf(readFileSync(DIST, 'utf-8'))).toEqual([]);
    });

    it('does not touch `process` unguarded — workerd has none', () => {
        const src = readFileSync(SRC, 'utf-8');
        for (const m of src.matchAll(/process\.env/g)) {
            const before = src.slice(Math.max(0, m.index! - 120), m.index!);
            expect(before, 'every process.env read must be typeof-guarded').toMatch(/typeof process/);
        }
    });

    it('resolves entries with no host APIs available', () => {
        const manifest: ViteManifest = {
            'src/entry-client.tsx': {
                file: 'assets/entry-abc.js',
                isEntry: true,
                imports: ['_shared-def.js'],
                css: ['assets/entry.css']
            },
            '_shared-def.js': { file: 'assets/shared-def.js', css: ['assets/shared.css'] }
        };
        const assets = collectAssets(manifest, ['src/entry-client.tsx'], '/base/');
        expect(assets.modulepreload).toEqual(['/base/assets/entry-abc.js', '/base/assets/shared-def.js']);
        expect(assets.stylesheets).toEqual(['/base/assets/entry.css', '/base/assets/shared.css']);
    });
});
