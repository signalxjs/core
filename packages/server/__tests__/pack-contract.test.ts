/**
 * Architectural guard (#416, applied to this package by rfc-server-v5 #692):
 * `@sigx/server` rides ONLY public surface — no `/internals` imports anywhere
 * in `src`, and the size-limited client entry (`@sigx/server/client`, the
 * "stubs drag no runtime" guard in `.size-limit.mjs`) plus the modules it
 * pulls in import nothing from the runtime at all. Everything this package
 * does, an out-of-tree pack can do with the same typed imports.
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

describe('@sigx/server rides only public surface (#416, #692)', () => {
    it('no source file imports from an /internals entry', () => {
        // `sigx/internals` / `@sigx/*/internals` are change-without-notice
        // surface (rfc-1.0 §1.2) — a pack that needs something from there
        // needs the export promoted (as `provideTypeHandlers` was, #692),
        // not the import.
        // Matches `from '…/internals'`, a bare side-effect `import '…/internals'`
        // and a dynamic `import('…/internals')`, with or without an explicit
        // extension (`sigx/internals`, `sigx/internals.js`, `.mjs`, `.ts`).
        const INTERNALS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*\/internals(?:\.[cm]?[jt]s)?['"]/;
        const offenders = collectTsFiles(srcRoot).filter((file) =>
            INTERNALS_IMPORT.test(readFileSync(file, 'utf-8'))
        );
        expect(offenders).toEqual([]);
    });

    it('the client entry and its dependencies import nothing from the runtime', () => {
        // The structural twin of the `.size-limit.mjs` no-ignore rule on
        // `@sigx/server/client`: a resume handler chunk replicates these
        // imports, and a zero-JS page must not pull the framework to make
        // one RPC call. `@sigx/serialize` is the one allowed dependency.
        const RUNTIME_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](sigx|@sigx\/(runtime-core|runtime-dom|reactivity|server-renderer|cache|resume|ssr-islands|vite))(\/[^'"]*)?['"]/;
        const clientFiles = [
            join(srcRoot, 'client', 'index.ts'),
            join(srcRoot, 'wire-codec.ts'),
            join(srcRoot, 'fn-url.ts'),
            join(srcRoot, 'errors.ts')
        ];
        const offenders = clientFiles.filter((file) => RUNTIME_IMPORT.test(readFileSync(file, 'utf-8')));
        expect(offenders).toEqual([]);
    });
});
