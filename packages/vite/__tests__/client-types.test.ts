/**
 * @vitest-environment node
 *
 * `@sigx/vite/client` — the shipped ambient types for the `virtual:*` modules
 * (#562). This file is hand-written and lives at the package ROOT (`tsc` will
 * not copy a `.d.ts` out of `src/` into `dist/`), so its packaging is the part
 * that can silently break: a missing `files` entry or a mistyped `exports`
 * route publishes a package whose types simply are not there, and nothing else
 * in the suite would notice.
 *
 * What the file DECLARES is checked by the type-checker instead —
 * `pnpm typecheck` (the root config includes it) and `pnpm typecheck:examples`,
 * where all three example apps now resolve these types instead of hand-copied
 * copies of them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
    files: string[];
    exports: Record<string, Record<string, string>>;
};

describe('@sigx/vite/client packaging', () => {
    it('is exported as a types-only subpath', () => {
        // Types-only on purpose: there is no runtime module behind it, so a
        // stray `import` condition would resolve to a file that cannot exist.
        expect(pkg.exports['./client']).toEqual({ types: './client.d.ts' });
    });

    it('ships in the tarball', () => {
        // `files` lists directories elsewhere; this one file sits at the root
        // and needs its own entry.
        expect(pkg.files).toContain('client.d.ts');
        expect(existsSync(join(packageRoot, 'client.d.ts'))).toBe(true);
    });

    it('declares every virtual module the plugins generate', () => {
        const source = readFileSync(join(packageRoot, 'client.d.ts'), 'utf-8');
        for (const id of [
            'virtual:sigx-server-fns',
            'virtual:sigx-app',
            'virtual:sigx-manifests',
            'virtual:sigx-islands',
            'virtual:sigx-resume/entry'
        ]) {
            expect(source).toContain(`declare module '${id}'`);
        }
    });

    it('never imports the optional pack peers', () => {
        // @sigx/ssr-islands and @sigx/resume are OPTIONAL peers: an app with
        // only one of them installed must still type-check, so the manifests
        // are typed through the SigxPackManifests registry each pack augments
        // — never by importing the packs here.
        // (The prose above the declarations names both packs — it is the
        // `from '…'` that would break an app, so that is what is asserted.)
        const source = readFileSync(join(packageRoot, 'client.d.ts'), 'utf-8');
        expect(source).not.toMatch(/from\s*'@sigx\/(ssr-islands|resume)'/);
        expect(source).toContain('interface SigxPackManifests');
    });
});
