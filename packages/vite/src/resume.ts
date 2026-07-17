/**
 * sigxResume() — the Vite half of the resumability pack (#241; sibling of
 * sigxIslands, which it mirrors structurally).
 *
 * Five jobs, keyed on the resume file convention (configurable):
 *
 * 1. **Handler extraction** — `extractResumeHandlers` (see resume-extract.ts)
 *    rewrites resume modules so handled elements carry
 *    `data-sigx-on:<event>="<symbol>"` QRL attributes, and produces a per-file
 *    handlers module of `($scope, …) => …` exports.
 * 2. **Stable identity** — stamps `__resumeId` (export name, the registry key)
 *    and `__resumeMode` ('resume', or 'hydrate' when any handler was
 *    ineligible / the component consumes slots) on exported factories, and
 *    keys named signals via `injectSignalNames` (shared with islands).
 * 3. **Client registration** — `virtual:sigx-resume` registers a lazy QRL
 *    loader per handler symbol and an upgrade-chunk loader per component;
 *    both code-split behind dynamic imports that only execute on interaction.
 * 4. **Loader entry** — `virtual:sigx-resume/entry` is the page's only
 *    script: it wires the delegation loader with the build-wide union of
 *    handled event names and lazy references to the registry and runtime.
 * 5. **Build manifest** — the client build emits
 *    `.vite/sigx-resume-manifest.json` (`components` for upgrade chunks —
 *    feed to `resumePlugin({ manifest })` — and `handlers` for
 *    modulepreload hints).
 *
 * Handlers modules may contain TypeScript (annotations are preserved
 * verbatim); `load()` strips the types itself via `transformWithOxc` — the
 * dev pipeline skips \0-prefixed ids, so the `.handlers.ts` suffix alone
 * never triggers stripping (#270). Their relative imports are resolved
 * against the source file they were extracted from.
 *
 * Unlike islands' one-shot discovery, resume registrations change whenever a
 * handler body changes (content-hashed symbols), so the `hotUpdate` hook
 * re-extracts and invalidates the virtual modules.
 */

import type { Plugin } from 'vite';
import { createFilter, normalizePath, transformWithOxc } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractResumeHandlers, offsetToLoc, type ResumeExtraction } from './resume-extract.js';
import { injectSignalNames, walkFiles } from './islands.js';

export interface SigxResumeOptions {
    /**
     * Which modules are resume modules. Default:
     * `['**' + '/*.resume.{ts,tsx}', '**' + '/resume/**' + '/*.{ts,tsx}']`.
     */
    include?: string | string[];
    /** Excluded from matching. Default: node_modules and dist. */
    exclude?: string | string[];
}

const VIRTUAL_ID = 'virtual:sigx-resume';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;
const ENTRY_ID = 'virtual:sigx-resume/entry';
const RESOLVED_ENTRY_ID = '\0' + ENTRY_ID;
const HANDLERS_PREFIX = 'virtual:sigx-resume:';
const RESOLVED_HANDLERS_PREFIX = '\0' + HANDLERS_PREFIX;
const HANDLERS_SUFFIX = '.handlers.ts';
const MANIFEST_FILE = '.vite/sigx-resume-manifest.json';

const DEFAULT_INCLUDE = ['**/*.resume.ts', '**/*.resume.tsx', '**/resume/**/*.ts', '**/resume/**/*.tsx'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

/** Manifest shape: upgrade chunks per component, preload hints per symbol. */
export interface SigxResumeManifest {
    components: Record<string, { chunkUrl: string; exportName: string }>;
    handlers: Record<string, { chunkUrl: string; exportName: string }>;
}

export function sigxResume(options: SigxResumeOptions = {}): Plugin {
    const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);

    let root = process.cwd();
    let isServe = false;
    /** Latest extraction per absolute module path (files with components only). */
    const extractions = new Map<string, ResumeExtraction>();

    const relPath = (file: string): string => path.relative(root, file).replace(/\\/g, '/');
    const handlersIdFor = (file: string): string => HANDLERS_PREFIX + relPath(file) + HANDLERS_SUFFIX;
    const fileOfHandlersId = (resolved: string): string =>
        normalizePath(path.resolve(root, resolved.slice(RESOLVED_HANDLERS_PREFIX.length, -HANDLERS_SUFFIX.length)));

    function extractInto(file: string, code: string): ResumeExtraction | null {
        // Map keys must use ONE separator: discovery walks the fs (native
        // backslashes on Windows) while transform/hotUpdate get Vite's
        // forward-slash ids — unnormalized, the same file registers twice
        // and every component warns as its own duplicate (#324).
        file = normalizePath(file);
        let extraction: ResumeExtraction;
        try {
            extraction = extractResumeHandlers(code, file);
        } catch (error) {
            // Unparsable source (mid-edit, syntax error) keeps the last good
            // extraction — but say so: silence here would also hide real
            // extraction bugs during discovery and builds.
            console.warn(`[sigx:resume] extraction failed for ${relPath(file)}:`, error);
            return null;
        }
        if (extraction.components.length === 0) {
            extractions.delete(file);
            return extraction;
        }
        // Rolldown can run the transform more than once per module (scan +
        // build phases), the later pass over our OWN output — where the
        // idempotency skip reports zero sites. Never clobber an informative
        // extraction with that empty echo.
        const cached = extractions.get(file);
        const informative = !cached || extraction.components.some((c) => c.siteCount > 0 || c.signalCount > 0);
        if (informative) extractions.set(file, extraction);
        return extraction;
    }

    function discover(): void {
        extractions.clear();
        for (const file of walkFiles(root)) {
            if (!filter(file)) continue;
            extractInto(file, fs.readFileSync(file, 'utf-8'));
        }
    }

    /** Components worth stamping/registering: they own state or handler sites. */
    const stampable = (extraction: ResumeExtraction) =>
        extraction.components.filter((c) => c.siteCount > 0 || c.signalCount > 0);

    /**
     * Component export names are app-wide registry/manifest keys (like island
     * names). Duplicates across resume modules would silently overwrite each
     * other's upgrade loaders — first file wins, the rest warn and are
     * skipped from registration and the manifest.
     */
    const warnedDuplicates = new Set<string>();
    function ownedBy(name: string, file: string): boolean {
        for (const [otherFile, extraction] of extractions) {
            if (otherFile === file) return true;
            if (extraction.components.some((c) => c.exported === name)) {
                // Called from load() AND generateBundle() — warn once per pair.
                const key = `${name}\0${file}`;
                if (!warnedDuplicates.has(key)) {
                    warnedDuplicates.add(key);
                    console.warn(
                        `[sigx:resume] duplicate resume component name "${name}" ` +
                        `(${otherFile} vs ${file}) — component names must be unique; keeping the first.`
                    );
                }
                return false;
            }
        }
        return true;
    }

    return {
        name: 'sigx:resume',
        // The extraction needs RAW TSX: rolldown's full-bundle mode compiles
        // JSX natively before normal-phase transforms run (sigxIslands'
        // regexes tolerate compiled output; AST handler discovery cannot).
        enforce: 'pre',

        configResolved(config) {
            root = config.root;
            isServe = config.command === 'serve';
            discover();
        },

        resolveId(id, importer) {
            if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
            if (id === ENTRY_ID) return RESOLVED_ENTRY_ID;
            if (id.startsWith(HANDLERS_PREFIX)) return '\0' + id;
            // Relative imports replicated into a handlers module resolve
            // against the source file the handlers were extracted from.
            if (importer?.startsWith(RESOLVED_HANDLERS_PREFIX) && id.startsWith('.')) {
                return this.resolve(id, fileOfHandlersId(importer), { skipSelf: true });
            }
        },

        load(id) {
            if (id === RESOLVED_VIRTUAL_ID) {
                const lines = [
                    "import { __registerResumeQrl } from '@sigx/resume/client';",
                    "import { __registerIslandChunk } from '@sigx/server-renderer/client';"
                ];
                for (const [file, extraction] of extractions) {
                    const handlersSpec = JSON.stringify(handlersIdFor(file));
                    for (const handler of extraction.handlers) {
                        lines.push(
                            `__registerResumeQrl(${JSON.stringify(handler.symbol)}, () => import(${handlersSpec}).then(m => m[${JSON.stringify(handler.symbol)}]));`
                        );
                    }
                    const moduleSpec = JSON.stringify('/' + relPath(file));
                    for (const comp of stampable(extraction)) {
                        if (!ownedBy(comp.exported, file)) continue;
                        lines.push(
                            `__registerIslandChunk(${JSON.stringify(comp.exported)}, () => import(${moduleSpec}).then(m => m[${JSON.stringify(comp.exported)}]));`
                        );
                    }
                }
                return lines.join('\n');
            }
            if (id === RESOLVED_ENTRY_ID) {
                const events = new Set<string>();
                for (const extraction of extractions.values()) {
                    for (const event of extraction.events) events.add(event);
                }
                return [
                    "import { initResume } from '@sigx/resume/loader';",
                    `initResume(${JSON.stringify([...events].sort())}, () => import(${JSON.stringify(VIRTUAL_ID)}), () => import('@sigx/resume/client'));`
                ].join('\n');
            }
            if (id.startsWith(RESOLVED_HANDLERS_PREFIX)) {
                const extraction = extractions.get(fileOfHandlersId(id));
                const source = extraction?.handlersModule;
                if (!source) return 'export {};';
                // Handlers preserve the source's TS annotations, and Vite's
                // own transform pipeline skips \0-prefixed ids in dev (#270)
                // — the .ts suffix alone never strips them. Strip here so
                // the module is plain JS in every mode.
                return transformWithOxc(source, id.slice(1), { lang: 'ts' });
            }
        },

        transform(code, id) {
            const clean = id.split('?')[0];
            if (!filter(clean)) return null;
            // The incoming code is authoritative (dev edits arrive here before
            // any fs watcher) — re-extract and refresh the registry cache.
            const extraction = extractInto(clean, code);
            if (!extraction || extraction.components.length === 0) return null;

            if (extraction.ineligible.length > 0) {
                if (isServe) {
                    for (const miss of extraction.ineligible) {
                        const { line, column } = offsetToLoc(code, miss.offset);
                        this.warn(
                            `[sigx:resume] ${relPath(clean)}:${line}:${column} on${miss.event} of <${miss.component}> ` +
                            `is not resumable — ${miss.reason}; the component falls back to interaction hydration.`
                        );
                    }
                } else {
                    this.warn(
                        `[sigx:resume] ${relPath(clean)}: ${extraction.ineligible.length} handler(s) not resumable ` +
                        `(${extraction.ineligible.map((m) => `on${m.event} of <${m.component}>`).join(', ')}) — ` +
                        `affected components fall back to interaction hydration.`
                    );
                }
            }

            const stamps = stampable(extraction)
                .map(({ local, exported, mode }) =>
                    `if (typeof ${local} === 'function' && ${local}.__setup) { ` +
                    `${local}.__resumeId = ${JSON.stringify(exported)}; ` +
                    `${local}.__resumeMode = ${JSON.stringify(mode)}; }`)
                .join('\n');
            if (!stamps && extraction.code === code) return null;
            return { code: `${injectSignalNames(extraction.code)}\n;${stamps}\n`, map: null };
        },

        async hotUpdate({ type, file, read }) {
            if (!filter(file)) return;
            if (type === 'delete') extractions.delete(normalizePath(file));
            else extractInto(file, await read());
            const graph = this.environment.moduleGraph;
            for (const vid of [RESOLVED_VIRTUAL_ID, RESOLVED_ENTRY_ID, RESOLVED_HANDLERS_PREFIX + relPath(file) + HANDLERS_SUFFIX]) {
                const mod = graph.getModuleById(vid);
                if (mod) graph.invalidateModule(mod);
            }
        },

        generateBundle: {
            handler(_, bundle) {
                // Only the client build carries browser chunk URLs.
                if (this.environment?.name && this.environment.name !== 'client') return;

                const manifest: SigxResumeManifest = { components: {}, handlers: {} };
                const byModule = new Map<string, string>();
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type === 'chunk' && chunk.facadeModuleId) {
                        byModule.set(chunk.facadeModuleId.split('?')[0].replace(/\\/g, '/'), chunk.fileName);
                    }
                }
                for (const [file, extraction] of extractions) {
                    const componentChunk = byModule.get(file.replace(/\\/g, '/'));
                    if (componentChunk) {
                        for (const comp of stampable(extraction)) {
                            if (!ownedBy(comp.exported, file)) continue;
                            manifest.components[comp.exported] = { chunkUrl: '/' + componentChunk, exportName: comp.exported };
                        }
                    }
                    const handlersChunk = byModule.get(RESOLVED_HANDLERS_PREFIX + relPath(file) + HANDLERS_SUFFIX);
                    if (handlersChunk) {
                        for (const handler of extraction.handlers) {
                            manifest.handlers[handler.symbol] = { chunkUrl: '/' + handlersChunk, exportName: handler.symbol };
                        }
                    }
                }
                if (Object.keys(manifest.components).length + Object.keys(manifest.handlers).length > 0) {
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
