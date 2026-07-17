/**
 * sigxServer() — the Vite half of the server-function pack (rfc-server §3,
 * #305; sibling of sigxResume, which it mirrors structurally).
 *
 * Four jobs, keyed on the server-module file convention (configurable):
 *
 * 1. **Stub swap** — in the CLIENT environment, every matching module is
 *    replaced wholesale by `extractServerFns`'s stub module (typed fetch
 *    stubs keyed by content-hashed symbol). The SSR environment sees the
 *    real module untouched — `serverFn` is pure runtime there.
 * 2. **Prod registry** — `virtual:sigx-server-fns` maps symbol → lazy import
 *    of the real module; the SSR build emits it as `sigx-server-fns.js` next
 *    to the server entry. Pass its `serverFns` export EXPLICITLY to
 *    `createServerFnHandler` (the resume-manifest posture, never ambient).
 * 3. **Inline extraction** — a module-scope `const x = serverFn(...)` in ANY
 *    other client-reachable file is extracted in place (rfc-server §1.1(b)):
 *    client build gets the stub + orphaned-import stripping, SSR build keeps
 *    the body and gains a mangled export the endpoint resolves. Capture
 *    violations (module scope, component scope, JSX) are HARD errors —
 *    see `server-fn-inline.ts`. (Resume handlers can't capture module-scope
 *    consts — they import from `*.server.ts` modules instead.)
 * 4. **Dev endpoint** — a `configureServer` middleware on the plugin's base
 *    path resolves symbols through the in-memory extraction maps and
 *    `ssrLoadModule` (edits apply per request). The request logic itself is
 *    loaded through `ssrLoadModule('@sigx/server/node')` for module-graph
 *    identity (the concern documented in `./ssr.ts`).
 *
 * Symbols change when a function's body changes (content-hashed), so
 * `hotUpdate` re-extracts and invalidates the registry virtual module.
 */

import type { Plugin, ViteDevServer } from 'vite';
import { createFilter } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractServerFns, type ServerFnExtraction } from './server-fn-extract.js';
import { extractInlineServerFns, type InlineServerFnExtraction } from './server-fn-inline.js';
import { offsetToLoc } from './resume-extract.js';
import { walkFiles } from './islands.js';

export interface SigxServerOptions {
    /** Which modules are server modules. Default: `**` + `/*.server.{ts,tsx}`. */
    include?: string | string[];
    /** Excluded from matching. Default: node_modules and dist. */
    exclude?: string | string[];
    /** Endpoint prefix baked into stubs and served in dev. Default `/_sigx/fn`. */
    base?: string;
    /**
     * Dev guard: a Vite-root-relative module (e.g. '/src/fn-guard.ts') whose
     * `guard` export runs before every dev invocation — keep dev and prod
     * enforcing the same auth seam (rfc-server §5).
     */
    guard?: string;
    /** Origin policy forwarded to the dev endpoint. Default `'same-origin'`. */
    origin?: 'same-origin' | string[] | false;
    /** Body cap forwarded to the dev endpoint. Default 1 MiB. */
    maxBodyBytes?: number;
}

const VIRTUAL_ID = 'virtual:sigx-server-fns';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;
const REGISTRY_FILE = 'sigx-server-fns.js';

const DEFAULT_INCLUDE = ['**/*.server.ts', '**/*.server.tsx'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];
const DEFAULT_BASE = '/_sigx/fn';

/** `import … from '@sigx/server'` (not -renderer), excluding type-only.
 *  The lookahead sits directly after `import` — a backtrackable `\s*` before
 *  it would let `import type {` match with zero spaces consumed. */
const SERVER_IMPORT_RE = /import(?!\s*type\b)([^;'"]*)from\s*['"]@sigx\/server['"]/g;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (name: string): string => name.replace(REGEX_SPECIALS, '\\$&');

/**
 * Call-site patterns for `serverFn` as value-imported from '@sigx/server' —
 * named (aliased or not) and namespace imports. Best-effort dev lint, not
 * an analysis: re-exports and indirections are out of scope.
 */
function serverFnCallPatterns(code: string): RegExp[] {
    const patterns: RegExp[] = [];
    for (const match of code.matchAll(SERVER_IMPORT_RE)) {
        const clause = match[1];
        const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
        if (namespace) {
            patterns.push(new RegExp(`(?<![\\w$.])${escapeRe(namespace[1])}\\s*\\.\\s*serverFn\\s*\\(`));
            continue;
        }
        if (/\btype\s+serverFn\b/.test(clause)) continue; // inline type import
        const spec = /\bserverFn\b(?:\s+as\s+([\w$]+))?/.exec(clause);
        if (spec) {
            // Escape the alias ($ is a valid identifier char but a regex
            // anchor); the lookbehind's dot exclusion keeps unrelated
            // property calls (obj.serverFn()) from matching.
            patterns.push(new RegExp(`(?<![\\w$.])${escapeRe(spec[1] ?? 'serverFn')}\\s*\\(`));
        }
    }
    return patterns;
}

/** Does the code call serverFn under any of its imported names? */
function callsServerFn(code: string): boolean {
    return serverFnCallPatterns(code).some((pattern) => pattern.test(code));
}

export function sigxServer(options: SigxServerOptions = {}): Plugin {
    const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);
    const base = options.base ?? DEFAULT_BASE;

    let root = process.cwd();
    let isServe = false;
    /** Latest extraction per absolute module path (matching files only). */
    const extractions = new Map<string, ServerFnExtraction>();
    /** Inline extractions per absolute module path (non-matching files). */
    const inline = new Map<string, InlineServerFnExtraction>();

    const relPath = (file: string): string => path.relative(root, file).replace(/\\/g, '/');

    function extractInto(file: string, code: string): ServerFnExtraction | null {
        try {
            const extraction = extractServerFns(code, file, relPath(file), base);
            extractions.set(file, extraction);
            return extraction;
        } catch (error) {
            // Unparsable source (mid-edit) keeps the last good extraction —
            // but say so: silence would also hide real extraction bugs.
            console.warn(`[sigx:server] extraction failed for ${relPath(file)}:`, error);
            return null;
        }
    }

    function extractInlineInto(file: string, code: string): InlineServerFnExtraction | null {
        try {
            const extraction = extractInlineServerFns(code, file, relPath(file), base);
            if (extraction.fns.length > 0) inline.set(file, extraction);
            else inline.delete(file);
            return extraction;
        } catch (error) {
            console.warn(`[sigx:server] inline extraction failed for ${relPath(file)}:`, error);
            return null;
        }
    }

    /** Cheap gate before parsing a non-matching file for inline serverFn. */
    const inlineCandidate = (file: string, code: string): boolean =>
        /\.(ts|tsx|js|jsx|mts|mjs)$/.test(file) &&
        !file.includes('node_modules') &&
        callsServerFn(code);

    function discover(): void {
        extractions.clear();
        inline.clear();
        for (const file of walkFiles(root)) {
            if (filter(file)) {
                extractInto(file, fs.readFileSync(file, 'utf-8'));
                continue;
            }
            // Inline candidates must be known BEFORE the registry virtual
            // module loads — the SSR build reads it early.
            if (!/\.(ts|tsx|js|jsx|mts|mjs)$/.test(file)) continue;
            const code = fs.readFileSync(file, 'utf-8');
            if (inlineCandidate(file, code)) extractInlineInto(file, code);
        }
    }

    function findSymbol(symbol: string): { file: string; exportName: string } | null {
        for (const [file, extraction] of extractions) {
            const fn = extraction.fns.find((f) => f.symbol === symbol);
            if (fn) return { file, exportName: fn.name };
        }
        for (const [file, extraction] of inline) {
            const fn = extraction.fns.find((f) => f.symbol === symbol);
            if (fn) return { file, exportName: fn.mangled };
        }
        return null;
    }

    return {
        name: 'sigx:server',
        enforce: 'pre',

        configResolved(config) {
            root = config.root;
            isServe = config.command === 'serve';
            discover();
        },

        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
        },

        load(id) {
            if (id !== RESOLVED_VIRTUAL_ID) return;
            const lines: string[] = ['export const serverFns = {'];
            for (const [file, extraction] of extractions) {
                const moduleSpec = JSON.stringify('/' + relPath(file));
                for (const fn of extraction.fns) {
                    lines.push(
                        `    ${JSON.stringify(fn.symbol)}: () => import(${moduleSpec}).then(m => m[${JSON.stringify(fn.name)}]),`
                    );
                }
            }
            for (const [file, extraction] of inline) {
                const moduleSpec = JSON.stringify('/' + relPath(file));
                for (const fn of extraction.fns) {
                    lines.push(
                        `    ${JSON.stringify(fn.symbol)}: () => import(${moduleSpec}).then(m => m[${JSON.stringify(fn.mangled)}]),`
                    );
                }
            }
            lines.push('};');
            return lines.join('\n');
        },

        buildStart() {
            // The SSR build carries the registry chunk; serve resolves live.
            if (isServe) return;
            if (this.environment?.name === 'client') return;
            let hasFns = false;
            for (const extraction of extractions.values()) {
                if (extraction.fns.length > 0) hasFns = true;
            }
            for (const extraction of inline.values()) {
                if (extraction.fns.length > 0) hasFns = true;
            }
            if (!hasFns) return;
            this.emitFile({ type: 'chunk', id: VIRTUAL_ID, fileName: REGISTRY_FILE });
        },

        transform(code, id) {
            const clean = id.split('?')[0];
            if (!filter(clean)) {
                // Inline extraction (rfc-server §1.1(b)): module-scope
                // serverFn declarations in any other client-reachable file.
                // (Our own stub output imports '@sigx/server/client', not
                // '@sigx/server', so re-runs never pass this gate.)
                if (!inlineCandidate(clean, code)) return null;
                const extraction = extractInlineInto(clean, code);
                if (!extraction) {
                    // Parse failure mid-edit: NEVER let the original module
                    // (server body included) reach the browser — last good
                    // client output, else a loud refusal.
                    if (this.environment?.name === 'client') {
                        const cached = inline.get(clean)?.clientModule;
                        return {
                            code:
                                cached ??
                                `throw new Error(${JSON.stringify(
                                    `[sigx:server] could not extract inline serverFn from ${relPath(clean)} ` +
                                    `(syntax error?) — refusing to serve the module to the browser.`
                                )});`,
                            map: null
                        };
                    }
                    return null;
                }
                if (extraction.errors.length > 0) {
                    // Capture violations are HARD errors, never a degrade.
                    const detail = extraction.errors
                        .map((e) => {
                            const { line, column } = offsetToLoc(code, e.offset);
                            return `${relPath(clean)}:${line}:${column} ${e.message}`;
                        })
                        .join('\n');
                    this.error(`[sigx:server] inline serverFn extraction failed:\n${detail}`);
                }
                if (extraction.fns.length === 0) return null;
                const out =
                    this.environment?.name === 'client'
                        ? extraction.clientModule
                        : extraction.ssrModule;
                return out ? { code: out, map: null } : null;
            }
            // Rolldown can run the transform more than once per module (scan
            // + build phases), the later pass over our OWN stub output —
            // never let that echo clobber the real extraction (the shared
            // registry cache feeds the SSR build). Match the exact generated
            // header, not any '@sigx/server/client' import — a real server
            // module may legitimately import the client entry.
            if (/^import \{ __server(?:FnStub|Only)/.test(code)) return null;
            // The incoming code is authoritative (dev edits arrive here before
            // any fs watcher) — re-extract and refresh the registry cache.
            const extraction = extractInto(clean, code);
            for (const warning of extraction?.warnings ?? []) {
                this.warn(`[sigx:server] ${relPath(clean)}: ${warning}`);
            }
            if (this.environment?.name === 'client') {
                // NEVER serve the real module to the browser — on a failed
                // extraction (mid-edit syntax error) fall back to the last
                // good stub, and failing that, to a loud refusal.
                const stub = (extraction ?? extractions.get(clean))?.stubModule;
                return {
                    code:
                        stub ??
                        `throw new Error(${JSON.stringify(
                            `[sigx:server] could not extract ${relPath(clean)} (syntax error?) — ` +
                            `refusing to serve the server module to the browser.`
                        )});`,
                    map: null
                };
            }
            return null;
        },

        async hotUpdate({ type, file, read }) {
            if (filter(file)) {
                if (type === 'delete') extractions.delete(file);
                else extractInto(file, await read());
            } else if (type === 'delete') {
                if (!inline.delete(file)) return;
            } else {
                const code = await read();
                // Re-extract when the file is (or was) an inline carrier.
                if (!inline.has(file) && !inlineCandidate(file, code)) return;
                extractInlineInto(file, code);
            }
            const mod = this.environment.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
            if (mod) this.environment.moduleGraph.invalidateModule(mod);
        },

        configureServer(server) {
            const prefix = base.endsWith('/') ? base : base + '/';
            server.middlewares.use(async (req, res, next) => {
                if (!req.url?.startsWith(prefix)) return next();
                try {
                    await handleDevRequest(server, req, res, next);
                } catch (err) {
                    next(err);
                }
            });

            async function handleDevRequest(
                devServer: ViteDevServer,
                req: IncomingMessage,
                res: ServerResponse,
                next: (err?: unknown) => void
            ): Promise<void> {
                // Through the SSR module runner for module-graph identity —
                // a Node-resolved copy would brand-check against different
                // module instances (see ./ssr.ts for the same concern).
                const nodeEntry = (await devServer.ssrLoadModule('@sigx/server/node')) as unknown as
                    typeof import('@sigx/server/node');
                const guardModule = options.guard
                    ? await devServer.ssrLoadModule(options.guard)
                    : undefined;
                const guard = guardModule?.guard as
                    import('@sigx/server/node').ServerFnHandlerOptions['guard'];
                const handler = nodeEntry.createServerFnHandler({
                    base,
                    origin: options.origin,
                    maxBodyBytes: options.maxBodyBytes,
                    guard,
                    resolve: async (symbol: string) => {
                        const record = findSymbol(symbol);
                        if (!record) return null;
                        const mod = await devServer.ssrLoadModule('/' + relPath(record.file));
                        return mod[record.exportName];
                    }
                });
                await handler(req, res, next);
            }
        }
    };
}
