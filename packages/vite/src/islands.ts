/**
 * sigxIslands() — the Vite half of the islands architecture
 * (rfc-ssr-platform §3.1; the plugin `IslandsPluginOptions.manifest` has
 * anticipated since #119).
 *
 * Three jobs, all keyed on the island file convention (configurable):
 *
 * 1. **Stable identity** — stamps `__islandId` on every named component
 *    export of an island module (the field the boundary registry keys on,
 *    `vnode.type.__islandId || __name`).
 * 2. **Client registration** — provides `virtual:sigx-islands`: importing it
 *    from the client entry registers a lazy loader per island
 *    (`__registerIslandChunk(name, () => import(...))`), so island chunks
 *    code-split and load on demand when their hydration strategy fires.
 * 3. **Build manifest** — the client build emits
 *    `.vite/sigx-islands-manifest.json` mapping island names to
 *    `{ chunkUrl, exportName }`; feed it to the server:
 *    `islandsPlugin({ manifest })`.
 *
 * Island convention: a matching module's NAMED exports that are sigx
 * component factories are islands, keyed by export name (names must be
 * unique across island files). Default match: `*.island.tsx?` anywhere, or
 * anything under an `islands/` directory.
 */

import type { Plugin } from 'vite';
import { createFilter } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SigxIslandsOptions {
    /**
     * Which modules are island modules. Default:
     * `['**' + '/*.island.{ts,tsx}', '**' + '/islands/**' + '/*.{ts,tsx}']`.
     */
    include?: string | string[];
    /** Excluded from matching. Default: node_modules and dist. */
    exclude?: string | string[];
}

const VIRTUAL_ID = 'virtual:sigx-islands';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;
const MANIFEST_FILE = '.vite/sigx-islands-manifest.json';

const DEFAULT_INCLUDE = ['**/*.island.ts', '**/*.island.tsx', '**/islands/**/*.ts', '**/islands/**/*.tsx'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

/**
 * Extract the named exports of an island module (source-level scan, same
 * pragmatic approach as the HMR transform). Covers:
 *   export const X = …   export function X(…)   export { X, Y as Z }
 */
export function scanIslandExports(code: string): string[] {
    const names = new Set<string>();
    for (const match of code.matchAll(/export\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const piece of match[1].split(',')) {
            const name = piece.split(/\sas\s/).pop()?.trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    return [...names];
}

/** Walk a directory collecting files (bounded to the project tree). */
function walkFiles(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, out);
        else out.push(full);
    }
    return out;
}

export function sigxIslands(options: SigxIslandsOptions = {}): Plugin {
    const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);

    let root = process.cwd();
    /** Discovered islands: export name → absolute module path. */
    const islands = new Map<string, string>();

    function discover(): void {
        islands.clear();
        for (const file of walkFiles(root)) {
            if (!filter(file)) continue;
            const code = fs.readFileSync(file, 'utf-8');
            for (const name of scanIslandExports(code)) {
                if (islands.has(name) && islands.get(name) !== file) {
                    console.warn(
                        `[sigx:islands] duplicate island export name "${name}" ` +
                        `(${islands.get(name)} vs ${file}) — island names must be unique; keeping the first.`
                    );
                    continue;
                }
                islands.set(name, file);
            }
        }
    }

    return {
        name: 'sigx:islands',

        configResolved(config) {
            root = config.root;
            discover();
        },

        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
        },

        load(id) {
            if (id !== RESOLVED_VIRTUAL_ID) return;
            // Client-side lazy registry: each island code-splits behind a
            // dynamic import that only executes when its strategy fires.
            const lines = ["import { __registerIslandChunk } from '@sigx/ssr-islands';"];
            for (const [name, file] of islands) {
                const spec = JSON.stringify('/' + path.relative(root, file).replace(/\\/g, '/'));
                lines.push(
                    `__registerIslandChunk(${JSON.stringify(name)}, () => import(${spec}).then(m => m[${JSON.stringify(name)}]));`
                );
            }
            return lines.join('\n');
        },

        transform(code, id) {
            const clean = id.split('?')[0];
            if (!filter(clean)) return null;
            const names = scanIslandExports(code);
            if (names.length === 0) return null;
            // Stamp the stable island identity on every exported component
            // factory — the registry key the boundary table's `component`
            // field carries (vnode.type.__islandId || __name).
            const stamps = names
                .map((name) =>
                    `if (typeof ${name} === 'function' && ${name}.__setup) { ${name}.__islandId = ${JSON.stringify(name)}; }`)
                .join('\n');
            return { code: `${code}\n;${stamps}\n`, map: null };
        },

        generateBundle: {
            handler(_, bundle) {
                // Only the client build carries browser chunk URLs.
                if (this.environment?.name && this.environment.name !== 'client') return;

                const manifest: Record<string, { chunkUrl: string; exportName: string }> = {};
                const byModule = new Map<string, string>();
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type === 'chunk' && chunk.facadeModuleId) {
                        byModule.set(chunk.facadeModuleId.split('?')[0].replace(/\\/g, '/'), chunk.fileName);
                    }
                }
                for (const [name, file] of islands) {
                    const chunkFile = byModule.get(file.replace(/\\/g, '/'));
                    if (chunkFile) {
                        manifest[name] = { chunkUrl: '/' + chunkFile, exportName: name };
                    }
                }
                if (Object.keys(manifest).length > 0) {
                    this.emitFile({
                        type: 'asset',
                        fileName: MANIFEST_FILE,
                        source: JSON.stringify(manifest, null, 2)
                    });
                }
            }
        }
    };
}
