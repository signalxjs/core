/**
 * @vitest-environment node
 *
 * Symlinked project roots (#512).
 *
 * Every path-keying plugin here mixes two sources of paths: `discover()` walks
 * the filesystem from `config.root`, while `transform` / `load` /
 * `generateBundle` deal in Vite's resolved ids — and rolldown resolves ids
 * THROUGH the filesystem. When the root traverses a symlink the two disagree
 * (`/link/…` from the walk, `/real/…` from the id) and the same file is two
 * different things to the plugin.
 *
 * `normalizePath` settles separators (#324, #406), not symlinks. This is the
 * level below: the same file, reached both ways, must be ONE entry.
 *
 * Reachable in the wild by anything whose root traverses a link — a symlinked
 * `~/dev`, a Docker bind mount, a CI checkout via symlink, macOS `/tmp`. The
 * failures are not cosmetic: an island silently misses the manifest and never
 * hydrates; a resume component is reported as its own duplicate and dropped
 * from the registry.
 *
 * These tests build the symlink deliberately rather than relying on the
 * platform — `vitest.setup.ts` hands the suite a realpathed `tmpdir()`, so
 * nothing else here reproduces the condition any more. Each one FAILS without
 * `resolveRoot`; that was verified by reverting it, not assumed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxResume } from '../src/resume';
import { sigxIslands, resolveRoot } from '../src/islands';

const COUNTER = `
import { component } from 'sigx';
export const Counter = component((ctx) => {
    const count = ctx.signal(0);
    return () => <button onClick={() => { count.value++; }}>{count.value}</button>;
});
`;

const ISLAND = `
import { component } from 'sigx';
export const Widget = component(() => () => <div>widget</div>);
`;

/** Capture console.warn for the duration of `fn`. */
function warnings(fn: () => void): string[] {
    const out: string[] = [];
    const spy = console.warn;
    console.warn = (...args: unknown[]) => void out.push(args.join(' '));
    try {
        fn();
    } finally {
        console.warn = spy;
    }
    return out;
}

describe('a symlinked project root (#512)', () => {
    let real: string;
    let link: string;

    beforeAll(() => {
        const parent = mkdtempSync(join(tmpdir(), 'sigx-symlink-'));
        real = join(parent, 'real');
        link = join(parent, 'link');
        mkdirSync(join(real, 'src', 'resume'), { recursive: true });
        mkdirSync(join(real, 'src', 'islands'), { recursive: true });
        writeFileSync(join(real, 'src', 'resume', 'Counter.tsx'), COUNTER);
        writeFileSync(join(real, 'src', 'islands', 'Widget.island.tsx'), ISLAND);
        // `'junction'` on Windows, not `'dir'`: a directory symlink needs
        // elevation or Developer Mode there, so `'dir'` EPERMs on an ordinary
        // contributor's machine (GitHub's runners are elevated, so CI would
        // never have told us). A junction needs no privilege, is a directory
        // link, and reproduces the same condition — a root reached through a
        // link. It requires an absolute target, which this is.
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        real = realpathSync.native(real);
    });

    afterAll(() => rmSync(join(link, '..'), { recursive: true, force: true }));

    it('resolveRoot hands back the spelling the module graph will use', () => {
        expect(resolveRoot({ root: link })).toBe(real);
        // A path with no link in it comes back untouched — no surprise rewriting.
        expect(resolveRoot({ root: real })).toBe(real);
    });

    it('honors resolve.preserveSymlinks — then ids keep the aliased spelling', () => {
        // The one case where resolving root would CREATE the mismatch it
        // exists to remove: Vite is preserving symlinks, so ids arrive spelled
        // through the link and the walk has to match them.
        expect(resolveRoot({ root: link, resolve: { preserveSymlinks: true } })).toBe(link);
    });

    it('islands: an island discovered through the link still reaches the manifest', () => {
        const plugin = sigxIslands() as any;
        plugin.configResolved({ root: link, command: 'build' });

        // The bundle speaks in resolved ids — the real path.
        const emitted: { fileName: string; source: string }[] = [];
        plugin.generateBundle.handler.call(
            {
                environment: { name: 'client' },
                emitFile: (file: any) => emitted.push(file),
                getModuleInfo: () => null
            },
            {},
            {
                'assets/Widget.js': {
                    type: 'chunk',
                    facadeModuleId: join(real, 'src', 'islands', 'Widget.island.tsx'),
                    fileName: 'assets/Widget.js'
                }
            }
        );

        // Without resolveRoot the discovery map holds `/link/…` while the
        // chunk announces `/real/…`, the lookup misses, and the island is
        // simply absent from the manifest — no warning, no error, and the
        // island never hydrates in the browser.
        const manifest = JSON.parse(emitted[0]?.source ?? '{"islands":{}}');
        expect(manifest.islands.Widget).toMatchObject({ exportName: 'Widget' });
    });

    it('resume: a component reached through the link and by its real path is ONE component', () => {
        const plugin = sigxResume() as any;
        plugin.configResolved({ root: link, command: 'build' });

        const logged = warnings(() => {
            // The id arrives as the real path, the way rolldown resolves it.
            plugin.transform.call(
                { warn: () => {} },
                COUNTER,
                join(real, 'src', 'resume', 'Counter.tsx')
            );
            // `ownedBy` — the duplicate check — runs when the registry is built.
            plugin.load.call({ warn: () => {} }, '\0virtual:sigx-resume');
        });

        // Without resolveRoot: `duplicate resume component name "Counter"
        // (/link/…/Counter.tsx vs /real/…/Counter.tsx)`, and the second is
        // skipped from registration and the manifest.
        expect(logged.filter((w) => w.includes('duplicate resume component name'))).toEqual([]);
    });

    it('resume: the generated registry imports a path inside the root', () => {
        const plugin = sigxResume() as any;
        plugin.configResolved({ root: link, command: 'build' });
        plugin.transform.call({ warn: () => {} }, COUNTER, join(real, 'src', 'resume', 'Counter.tsx'));

        const registry = plugin.load.call({ warn: () => {} }, '\0virtual:sigx-resume') as string;

        // The other half of the same bug: module specs are built with
        // `path.relative(root, file)`, so a root spelled through the link and a
        // file spelled real produce `../../real/src/…` — an import that
        // escapes the project root and resolves to nothing.
        expect(registry).not.toMatch(/\.\.\//);
        if (registry.includes('Counter')) {
            expect(registry).toContain('/src/resume/Counter.tsx');
        }
    });
});
