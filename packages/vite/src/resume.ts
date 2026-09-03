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
 * 2. **Stable identity** — stamps `__resumeId` (export name, the registry key),
 *    `__resumeMode` ('resume', or 'hydrate' when any handler was
 *    ineligible / the component consumes slots) and `__resumeQrls` (the
 *    component's handler symbols — what `resumePlugin`'s `assets()` hook
 *    turns into modulepreload links via the manifest, #410) on exported
 *    factories, and keys named signals via `injectSignalNames` (shared with
 *    islands).
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
 * Transform-time contract violations are BUILD ERRORS (rfc-1.0 §4.5), never
 * warn-and-skip: a duplicate component name across resume modules, a
 * component reachable only as `export default`, and a handler that binds or
 * references `$scope` / `$el`. Runtime faults (single-element root, a renamed
 * signal's buffered writes) stay `__DEV__` warnings in `@sigx/resume`.
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
import { extractResumeHandlers, formMarkedImportsOf, offsetToLoc, type ResumeExtraction } from './resume-extract.js';
import { injectSignalNames, resolveRoot, walkFiles } from './islands.js';

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
    /**
     * Build-failing contract violations per module (§4.5), formatted with
     * their source location at extraction time — `load()` has no source to
     * locate against, and the registry is where files nothing imported yet
     * still get reported.
     */
    const contractErrors = new Map<string, string[]>();
    /**
     * §6.4: sigx:server's public `api`, grabbed in configResolved. When
     * present (and not a `role: 'client'` build — a live client posts
     * cross-origin, which the Origin check would 403), submit handlers on
     * <form> elements that capture a form-marked serverFn get real
     * action/method attributes stamped.
     */
    /** Files already warned about an unstampable form — dev re-transforms. */
    const warnedForms = new Set<string>();

    let serverApi: {
        role?: string;
        endpoint?: string;
        resolveServerFn?(
            importer: string,
            specifier: string,
            exportName: string
        ): { stableSymbol: string; form: boolean } | null;
    } | null = null;

    const relPath = (file: string): string => path.relative(root, file).replace(/\\/g, '/');
    const handlersIdFor = (file: string): string => HANDLERS_PREFIX + relPath(file) + HANDLERS_SUFFIX;
    const fileOfHandlersId = (resolved: string): string =>
        normalizePath(path.resolve(root, resolved.slice(RESOLVED_HANDLERS_PREFIX.length, -HANDLERS_SUFFIX.length)));

    /**
     * A `<form>` that targets a `form: true` server function, in a file the
     * resume transform never looks at (#488).
     *
     * `form: true` stamps a native `action`/`method` so the form works with no
     * JS — but stamping lives in the resume extractor, and the extractor only
     * runs on files matching this plugin's `include` (`*.resume.tsx` and
     * `resume/**` by default). Everywhere else the form is never analysed at
     * all, so nothing was stamped and nothing said so: the author gets a form
     * that silently only works once JS has loaded.
     *
     * Cheap regex gate first — this runs on EVERY module the dev server
     * transforms, and parsing imports for the ~99% of files with no `<form>`
     * would be pure cost.
     */
    function warnUnstampableForm(this: { warn(msg: string): void }, code: string, file: string): void {
        const resolve = serverApi?.resolveServerFn;
        if (!resolve || !/<form[\s>]/.test(code)) return;
        if (warnedForms.has(file)) return;

        let targets: string[];
        try {
            targets = formMarkedImportsOf(code, file, (specifier, exportName) =>
                resolve(normalizePath(file), specifier, exportName));
        } catch {
            return; // Unparsable mid-edit — the real transform reports it.
        }
        if (targets.length === 0) return;

        warnedForms.add(file);
        // Deliberately hedged: this file is outside `include`, so it is never
        // parsed for handler sites and we cannot know whether the <form>'s
        // submit handler actually calls one of these. Naming the condition is
        // what keeps it from reading as a false assertion.
        this.warn(
            `[sigx:resume] ${relPath(file)} renders a <form> and imports ` +
            `${targets.map(t => `\`${t}\``).join(', ')}, declared \`form: true\`. ` +
            `If that form's submit handler calls one of them, it gets NO native ` +
            `action/method: stamping only runs on files matching sigxResume()'s ` +
            `\`include\`, and this file does not match — so the form would not work ` +
            `without JS. Move the component into a \`*.resume.tsx\` file (or widen ` +
            `\`include\`) to get the no-JS fallback, or drop \`form: true\` if RPC-only ` +
            `is what you want (rfc-server §6.4).`
        );
    }

    function extractInto(file: string, code: string): ResumeExtraction | null {
        // Map keys must use ONE separator: discovery walks the fs (native
        // backslashes on Windows) while transform/hotUpdate get Vite's
        // forward-slash ids — unnormalized, the same file registers twice
        // and every component warns as its own duplicate (#324).
        file = normalizePath(file);
        let extraction: ResumeExtraction;
        try {
            const resolve = serverApi?.resolveServerFn;
            extraction = extractResumeHandlers(
                code,
                file,
                resolve
                    ? {
                          resolveServerFn: (specifier, exportName) =>
                              resolve(file, specifier, exportName),
                          endpoint: serverApi?.endpoint
                      }
                    : {}
            );
        } catch (error) {
            // Unparsable source (mid-edit, syntax error) keeps the last good
            // extraction — but say so: silence here would also hide real
            // extraction bugs during discovery and builds.
            console.warn(`[sigx:resume] extraction failed for ${relPath(file)}:`, error);
            return null;
        }
        if (extraction.errors.length > 0) {
            contractErrors.set(
                file,
                extraction.errors.map((e) => {
                    const { line, column } = offsetToLoc(code, e.offset);
                    return `[sigx:resume] ${relPath(file)}:${line}:${column}: ${e.message}`;
                })
            );
        } else {
            contractErrors.delete(file);
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
        contractErrors.clear();
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
     * names). Two resume modules exporting the same name would silently
     * overwrite each other's upgrade loaders, so a duplicate is a BUILD ERROR
     * naming both files (§4.5) — it used to warn and keep the first, which
     * left the second component broken in prod with only a console line.
     */
    function duplicateOf(name: string, file: string): string | null {
        for (const [otherFile, extraction] of extractions) {
            if (otherFile === file) continue;
            if (extraction.components.some((c) => c.exported === name)) return otherFile;
        }
        return null;
    }

    /** Every §4.5 violation the plugin knows for FILE (or all files), as `this.error` messages. */
    function violationsIn(file?: string): string[] {
        const out: string[] = [];
        // A module whose ONLY component is default-exported has an error
        // entry but no extraction — the union keeps it reportable.
        const files = file ? [file] : [...new Set([...contractErrors.keys(), ...extractions.keys()])];
        for (const f of files) {
            for (const msg of contractErrors.get(f) ?? []) out.push(msg);
            const extraction = extractions.get(f);
            if (!extraction) continue;
            for (const comp of stampable(extraction)) {
                const other = duplicateOf(comp.exported, f);
                if (!other) continue;
                // Report each pair once when sweeping everything.
                if (!file && other < f) continue;
                out.push(
                    `[sigx:resume] duplicate resume component name "${comp.exported}": ` +
                    `${relPath(f)} and ${relPath(other)} both export it — export names are ` +
                    `app-wide registry and manifest keys and must be unique; rename one of them.`
                );
            }
        }
        return out;
    }

    /**
     * Fail the build with every violation at once. Each hook gets one
     * `this.error` (Rollup renders the message; the join keeps all of them
     * visible instead of a fix-one-rebuild loop).
     */
    function failOn(ctx: { error(message: string): never }, violations: string[]): void {
        if (violations.length > 0) ctx.error(violations.join('\n'));
    }

    return {
        name: 'sigx:resume',
        // The extraction needs RAW TSX: rolldown's full-bundle mode compiles
        // JSX natively before normal-phase transforms run (sigxIslands'
        // regexes tolerate compiled output; AST handler discovery cannot).
        enforce: 'pre',

        configResolved(config) {
            // #512: the spelling the module graph will use, so discovery keys
            // and transform ids agree under a symlinked root.
            root = resolveRoot(config);
            isServe = config.command === 'serve';
            const server = config.plugins?.find((p) => p.name === 'sigx:server');
            const api = (server?.api ?? null) as typeof serverApi;
            // role 'client' never stamps (§6.4) — drop the api entirely so
            // extraction takes the no-stamping path.
            serverApi = api && api.role !== 'client' ? api : null;
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
                failOn(this, violationsIn());
                const lines = [
                    "import { __registerResumeQrl } from '@sigx/resume/client';",
                    "import { registerComponentChunk } from '@sigx/server-renderer/client';"
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
                        lines.push(
                            `registerComponentChunk(${JSON.stringify(comp.exported)}, () => import(${moduleSpec}).then(m => m[${JSON.stringify(comp.exported)}]));`
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
            if (!filter(clean)) {
                warnUnstampableForm.call(this, code, clean);
                return null;
            }
            // The incoming code is authoritative (dev edits arrive here before
            // any fs watcher) — re-extract and refresh the registry cache.
            const extraction = extractInto(clean, code);
            if (!extraction) return null;
            // §4.5: contract violations fail the build here, where Vite
            // attributes the error to this module (dev overlay included).
            failOn(this, violationsIn(clean));
            if (extraction.components.length === 0) return null;

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
            // §6.4 stamping notes (ambiguous form target, author action) —
            // never errors: the page still works, just without the stamp.
            for (const note of extraction.warnings) {
                this.warn(`[sigx:resume] ${relPath(clean)}: ${note}`);
            }

            const stamps = stampable(extraction)
                .map(({ local, exported, mode }) => {
                    // The component's handler symbols: resumePlugin's
                    // assets() hook maps them through the manifest to the
                    // handlers chunk and modulepreloads it (#410). Hydrate
                    // mode has none (all-or-nothing) — no stamp, no preload.
                    const qrls = extraction.handlers
                        .filter((h) => h.component === exported)
                        .map((h) => h.symbol);
                    return (
                        `if (typeof ${local} === 'function' && ${local}.__setup) { ` +
                        `${local}.__resumeId = ${JSON.stringify(exported)}; ` +
                        `${local}.__resumeMode = ${JSON.stringify(mode)}; ` +
                        (qrls.length > 0 ? `${local}.__resumeQrls = ${JSON.stringify(qrls)}; ` : '') +
                        `}`
                    );
                })
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
                failOn(this, violationsIn());

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
