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
 * 3. **Dev endpoint** — a `configureServer` middleware on the plugin's base
 *    path resolves symbols through the in-memory extraction map and
 *    `ssrLoadModule` (edits apply per request). The request logic itself is
 *    loaded through `ssrLoadModule('@sigx/server/node')` for module-graph
 *    identity (the concern documented in `./ssr.ts`).
 * 4. **Dev lint** — `serverFn` referenced in a NON-matching file would ship
 *    its body to the client; `transform` warns (dev only).
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

/** `import … from '@sigx/server'` (not -renderer), excluding type-only. */
const SERVER_IMPORT_RE = /import\s*(?!type\b)[^;'"]*from\s*['"]@sigx\/server['"]/;
/** A serverFn call site, tolerant of formatting (`serverFn (`, newline). */
const SERVER_FN_CALL_RE = /\bserverFn\s*\(/;

export function sigxServer(options: SigxServerOptions = {}): Plugin {
    const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);
    const base = options.base ?? DEFAULT_BASE;

    let root = process.cwd();
    let isServe = false;
    /** Latest extraction per absolute module path (matching files only). */
    const extractions = new Map<string, ServerFnExtraction>();
    const lintWarned = new Set<string>();

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

    function discover(): void {
        extractions.clear();
        for (const file of walkFiles(root)) {
            if (!filter(file)) continue;
            extractInto(file, fs.readFileSync(file, 'utf-8'));
        }
    }

    function findSymbol(symbol: string): { file: string; name: string } | null {
        for (const [file, extraction] of extractions) {
            const fn = extraction.fns.find((f) => f.symbol === symbol);
            if (fn) return { file, name: fn.name };
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
            if (!hasFns) return;
            this.emitFile({ type: 'chunk', id: VIRTUAL_ID, fileName: REGISTRY_FILE });
        },

        transform(code, id) {
            const clean = id.split('?')[0];
            if (!filter(clean)) {
                // Dev lint: a serverFn outside the include pattern is NOT
                // extracted — its body would ship to the client.
                if (
                    isServe &&
                    !lintWarned.has(clean) &&
                    /\.(ts|tsx|js|jsx|mts|mjs)$/.test(clean) &&
                    !clean.includes('node_modules') &&
                    SERVER_FN_CALL_RE.test(code) &&
                    SERVER_IMPORT_RE.test(code)
                ) {
                    lintWarned.add(clean);
                    this.warn(
                        `[sigx:server] ${relPath(clean)} calls serverFn() but does not match the ` +
                        `server-module pattern (default **/*.server.{ts,tsx}) — it will NOT be ` +
                        `extracted and its body will ship to the client. Move it to a matching ` +
                        `file or adjust the plugin's include option.`
                    );
                }
                return null;
            }
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
                            `[sigx server] could not extract ${relPath(clean)} (syntax error?) — ` +
                            `refusing to serve the server module to the browser.`
                        )});`,
                    map: null
                };
            }
            return null;
        },

        async hotUpdate({ type, file, read }) {
            if (!filter(file)) return;
            if (type === 'delete') extractions.delete(file);
            else extractInto(file, await read());
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
                        return mod[record.name];
                    }
                });
                await handler(req, res, next);
            }
        }
    };
}
