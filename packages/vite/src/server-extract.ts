/**
 * `@sigx/vite/server-extract` — the pure server-function extractors for
 * NON-VITE bundlers (rfc-server rev 2, N.5). The lynx repo's Rspack loader
 * consumes exactly this analysis: `*.server.*` files → `stubModule`; other
 * files → inline extraction behind a cheap serverFn-import gate, hard-failing
 * on capture errors. `parseAst` stays imported from `vite` (a pure text→AST
 * function) — the loader takes `vite` as a build-time dependency.
 *
 * Everything re-exported here is pure (no I/O) EXCEPT `computeStableId`,
 * the one fs-touching helper: bundler integrations either call it or pass
 * their own `stableId` into the extractors' options.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export {
    extractServerFns,
    mintSymbols,
    readServerFnIdOption,
    type ExtractedServerFn,
    type ServerFnExtraction,
    type ServerFnExtractOptions
} from './server-fn-extract.js';
export {
    extractInlineServerFns,
    type InlineExtractionError,
    type InlineServerFn,
    type InlineServerFnExtraction
} from './server-fn-inline.js';
export { hash8, offsetToLoc } from './resume-extract.js';

/** Nearest enclosing package, or null when none exists up-tree. */
export type PackageProbe = { name: string; dir: string } | null;

/**
 * Root-independent stable id for a module (rfc-server rev 2, §3/N.4): the
 * nearest enclosing package.json's `name` joined with the file's
 * package-relative path (`@acme/api/src/cart.server.ts`), so every app
 * build of one solution mints the SAME id — and therefore the same
 * symbols — for a shared server module. Nameless or unparsable manifests
 * are skipped (the walk continues upward). Fallback when no named package
 * exists: the build-root-relative path (root-dependent — and containing
 * `../` segments for out-of-root files — so shared modules should live in
 * named packages).
 *
 * `cache` maps directory → probe result, hits AND misses, so sibling files
 * short-circuit; the caller owns it (per plugin instance, cleared on config
 * resolve). Cached for the process lifetime of the caller — renaming a
 * package needs a dev-server restart.
 */
export function computeStableId(
    file: string,
    root: string,
    cache?: Map<string, PackageProbe>
): string {
    const probe = probePackage(path.dirname(file), cache);
    const rel = (from: string): string => path.relative(from, file).replace(/\\/g, '/');
    return probe ? `${probe.name}/${rel(probe.dir)}` : rel(root);
}

function probePackage(dir: string, cache?: Map<string, PackageProbe>): PackageProbe {
    const cached = cache?.get(dir);
    if (cached !== undefined) return cached;
    /** Directories visited this walk — all get the final answer. */
    const visited: string[] = [];
    let result: PackageProbe = null;
    for (let current = dir; ; current = path.dirname(current)) {
        const known = cache?.get(current);
        if (known !== undefined) {
            result = known;
            break;
        }
        visited.push(current);
        const name = readPackageName(path.join(current, 'package.json'));
        if (name) {
            result = { name, dir: current };
            break;
        }
        if (path.dirname(current) === current) break; // fs root
    }
    for (const d of visited) cache?.set(d, result);
    return result;
}

function readPackageName(manifestPath: string): string | null {
    let raw: string;
    try {
        raw = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
        return null;
    }
    try {
        const name = (JSON.parse(raw) as { name?: unknown }).name;
        return typeof name === 'string' && name !== '' ? name : null;
    } catch {
        return null; // unparsable manifest — keep walking
    }
}
