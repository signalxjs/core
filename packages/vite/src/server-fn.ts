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
 *
 * rev 2 (native clients, #320): hash seeds use ROOT-INDEPENDENT stable ids
 * (package-qualified — every app build of one solution mints identical
 * symbols for shared server modules); the registry dual-registers hashed +
 * hash-free STABLE symbols (`<stableId>#<name>`) so backend redeploys never
 * break installed apps; `endpoint` (stub fetch target) splits from `base`
 * (server mount path); `role: 'client'` stubs EVERY environment and emits
 * no registry; `scan` discovers shared packages outside the Vite root.
 */

import type { Plugin, ViteDevServer } from 'vite';
import { createFilter, normalizePath } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    extractServerFns,
    type ServerFnExtraction,
    type ServerFnExtractOptions
} from './server-fn-extract.js';
import { extractInlineServerFns, type InlineServerFnExtraction } from './server-fn-inline.js';
import { computeStableId, type PackageProbe } from './server-extract.js';
import { offsetToLoc } from './resume-extract.js';
import { walkFiles } from './islands.js';

export interface SigxServerOptions {
    /** Which modules are server modules. Default: `**` + `/*.server.{ts,tsx}`. */
    include?: string | string[];
    /** Excluded from matching. Default: node_modules and dist. */
    exclude?: string | string[];
    /** SERVER mount path — the dev middleware and `createServerFnHandler`
     *  prefix. Default `/_sigx/fn`. (rev 2 split it from `endpoint`.) */
    base?: string;
    /**
     * Fetch target baked into stubs — an absolute URL for builds that call a
     * remote server. Default: `base`. Call-time precedence:
     * `configureServerFn` endpoint > this > `base`.
     */
    endpoint?: string;
    /**
     * `'auto'` (default): stub swap in the Vite `client` environment only —
     * the v1 web posture. `'client'`: this WHOLE build is a remote-server
     * client (lynx, terminal) — every environment gets stubs (baked with
     * STABLE symbols, deploy-durable for installed apps) and no registry
     * chunk is emitted; there is no server in this build.
     */
    role?: 'auto' | 'client';
    /**
     * Extra directories (absolute or root-relative) scanned for server
     * modules — shared workspace packages outside the Vite root
     * (rfc-server rev 2, N.4). Registry entries for out-of-root modules use
     * absolute-path specs; the dev resolver goes through `/@fs/`.
     */
    scan?: string[];
    /**
     * Dev guard: a Vite-root-relative module (e.g. '/src/fn-guard.ts') whose
     * `guard` export runs before every dev invocation — keep dev and prod
     * enforcing the same auth seam (rfc-server §5).
     */
    guard?: string;
    /**
     * Dev boundary refresh (rfc-server §6.3): a Vite-root-relative module
     * whose `renderBoundaries` export the dev endpoint forwards — the same
     * shape `createBoundaryRefresh` (`@sigx/resume/server`) builds for prod
     * entries, so single-flight refresh works identically in dev. Loaded
     * through the SSR module runner per request, like `guard`.
     */
    renderBoundaries?: string;
    /** Origin policy forwarded to the dev endpoint. Default `'same-origin'`. */
    origin?: 'same-origin' | 'verify-when-present' | string[] | false;
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
 * Call-site patterns for `serverFn`/`serverStream` as value-imported from
 * '@sigx/server' — named (aliased or not) and namespace imports.
 * Best-effort dev lint, not an analysis: re-exports and indirections are
 * out of scope.
 */
function serverFnCallPatterns(code: string): RegExp[] {
    const patterns: RegExp[] = [];
    for (const match of code.matchAll(SERVER_IMPORT_RE)) {
        const clause = match[1];
        const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
        if (namespace) {
            patterns.push(
                new RegExp(
                    `(?<![\\w$.])${escapeRe(namespace[1])}\\s*\\.\\s*server(?:Fn|Stream)\\s*\\(`
                )
            );
            continue;
        }
        for (const wrapper of ['serverFn', 'serverStream']) {
            if (new RegExp(`\\btype\\s+${wrapper}\\b`).test(clause)) continue; // inline type import
            const spec = new RegExp(`\\b${wrapper}\\b(?:\\s+as\\s+([\\w$]+))?`).exec(clause);
            if (spec) {
                // Escape the alias ($ is a valid identifier char but a regex
                // anchor); the lookbehind's dot exclusion keeps unrelated
                // property calls (obj.serverFn()) from matching.
                patterns.push(new RegExp(`(?<![\\w$.])${escapeRe(spec[1] ?? wrapper)}\\s*\\(`));
            }
        }
    }
    return patterns;
}

/** Does the code call serverFn/serverStream under any of its imported names? */
function callsServerFn(code: string): boolean {
    return serverFnCallPatterns(code).some((pattern) => pattern.test(code));
}

export function sigxServer(options: SigxServerOptions = {}): Plugin {
    const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);
    const base = options.base ?? DEFAULT_BASE;
    const endpoint = options.endpoint ?? base;
    const role = options.role ?? 'auto';

    let root = process.cwd();
    let isServe = false;
    let bundledServerBuild = false;
    /** Latest extraction per absolute module path (matching files only). */
    const extractions = new Map<string, ServerFnExtraction>();
    /** Inline extractions per absolute module path (non-matching files). */
    const inline = new Map<string, InlineServerFnExtraction>();
    /** Directory → nearest-package probe, for stable-id derivation. */
    const pkgCache = new Map<string, PackageProbe>();

    const relPath = (file: string): string => path.relative(root, file).replace(/\\/g, '/');
    const extractOptions = (file: string): ServerFnExtractOptions => ({
        stableId: computeStableId(file, root, pkgCache),
        endpoint,
        stubSymbols: role === 'client' ? 'stable' : 'hashed'
    });

    /** Is FILE inside the Vite root? (Scanned packages may not be.) */
    const inRoot = (file: string): boolean => {
        const rel = path.relative(root, file);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    /** Registry import spec: root-relative in root, absolute outside (§3). */
    const buildSpec = (file: string): string =>
        inRoot(file) ? '/' + relPath(file) : normalizePath(file);
    /** Dev-resolver spec: out-of-root modules load through `/@fs/`. */
    const devSpec = (file: string): string =>
        inRoot(file) ? '/' + relPath(file) : '/@fs/' + normalizePath(file);

    /** Does this build role treat CTX's environment as client output? */
    const isClientOut = (ctx: { environment?: { name?: string } }): boolean =>
        role === 'client' || ctx.environment?.name === 'client';

    function extractInto(file: string, code: string): ServerFnExtraction | null {
        // One separator for map keys — discovery walks the fs (native
        // backslashes on Windows), transform/hotUpdate get Vite's
        // forward-slash ids (#324).
        file = normalizePath(file);
        try {
            const extraction = extractServerFns(code, file, extractOptions(file));
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
        file = normalizePath(file); // see extractInto
        try {
            const extraction = extractInlineServerFns(code, file, extractOptions(file));
            if (extraction.fns.length > 0) inline.set(file, extraction);
            else inline.delete(file);
            return extraction;
        } catch (error) {
            console.warn(`[sigx:server] inline extraction failed for ${relPath(file)}:`, error);
            return null;
        }
    }

    /**
     * Cheap regex gate before PARSING a non-matching file for inline
     * serverFn. Deliberately approximate: a false positive (the pattern in
     * a comment/string) costs one parse — `extractInlineServerFns` is the
     * AST-accurate authority and returns no fns. False negatives require
     * indirection (re-exporting serverFn through another module), which is
     * documented as out of scope for inline extraction.
     */
    const inlineCandidate = (file: string, code: string): boolean =>
        /\.(ts|tsx|js|jsx|mts|mjs)$/.test(file) &&
        !file.includes('node_modules') &&
        callsServerFn(code);

    /** Absolute scan roots (resolved against the Vite root once known). */
    const scanDirs = (): string[] =>
        (options.scan ?? []).map((dir) => path.resolve(root, dir));

    function discover(): void {
        extractions.clear();
        inline.clear();
        const visited = new Set<string>();
        for (const dir of [root, ...scanDirs()]) {
            for (const file of walkFiles(dir)) {
                const key = normalizePath(file);
                if (visited.has(key)) continue; // a scan dir may sit inside root
                visited.add(key);
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
    }

    function findSymbol(symbol: string): { file: string; exportName: string } | null {
        // Dual routing (rev 2, N.3): hashed and stable symbols both resolve.
        for (const [file, extraction] of extractions) {
            const fn = extraction.fns.find((f) => f.symbol === symbol || f.stableSymbol === symbol);
            if (fn) return { file, exportName: fn.name };
        }
        for (const [file, extraction] of inline) {
            const fn = extraction.fns.find((f) => f.symbol === symbol || f.stableSymbol === symbol);
            if (fn) return { file, exportName: fn.mangled };
        }
        return null;
    }

    return {
        name: 'sigx:server',
        enforce: 'pre',
        // Cross-plugin introspection seam (rfc-deploy §3.3): when `sigx({
        // ssr })` grows its `adapter` option, its config branch reads this to
        // raise the config-time conflict error — `role: 'client'` describes a
        // build with no server in it, so an adapter (which shapes the server
        // build) cannot apply. The error lands with `adapter`; the seam
        // lands with `role` (here).
        api: { role, base, endpoint },

        configResolved(config) {
            root = config.root;
            isServe = config.command === 'serve';
            // The sigx plugin's adapter seam (mirror of our api.role): in a
            // BUNDLED server build the registry inlines into the one worker
            // bundle via the entry's `virtual:sigx-server-fns` import — an
            // emitted chunk would have no consumer (nothing imports dist
            // files by path at runtime on edge platforms).
            const sigxApi = config.plugins?.find((p) => p.name === 'sigx')?.api as
                | { adapter?: { serverBuild?: string } }
                | undefined;
            bundledServerBuild = sigxApi?.adapter?.serverBuild === 'bundled';
            pkgCache.clear();
            discover();
        },

        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
        },

        load(id) {
            if (id !== RESOLVED_VIRTUAL_ID) return;
            const lines: string[] = ['export const serverFns = {'];
            /** stableSymbol → file, to surface duplicate explicit `id`s. */
            const stableOwners = new Map<string, string>();
            const register = (
                file: string,
                fn: { symbol: string; stableSymbol: string },
                exportName: string
            ): void => {
                const moduleSpec = JSON.stringify(buildSpec(file));
                const record = `() => import(${moduleSpec}).then(m => m[${JSON.stringify(exportName)}])`;
                // Dual registration (rev 2, N.3): hashed keys keep the web's
                // skew detection; stable keys keep installed apps working
                // across backend redeploys.
                lines.push(`    ${JSON.stringify(fn.symbol)}: ${record},`);
                lines.push(`    ${JSON.stringify(fn.stableSymbol)}: ${record},`);
                const owner = stableOwners.get(fn.stableSymbol);
                if (owner && owner !== file) {
                    this.warn(
                        `[sigx:server] stable symbol ${JSON.stringify(fn.stableSymbol)} is minted by both ` +
                        `${relPath(owner)} and ${relPath(file)} (duplicate explicit \`id\`?) — ` +
                        `the later registration wins.`
                    );
                }
                stableOwners.set(fn.stableSymbol, file);
            };
            for (const [file, extraction] of extractions) {
                for (const fn of extraction.fns) register(file, fn, fn.name);
            }
            for (const [file, extraction] of inline) {
                for (const fn of extraction.fns) register(file, fn, fn.mangled);
            }
            lines.push('};');
            return lines.join('\n');
        },

        buildStart() {
            // The SSR build carries the registry chunk; serve resolves live.
            if (isServe) return;
            // A role:'client' build has no server — no registry, anywhere.
            if (role === 'client') return;
            // Bundled builds inline the registry (rfc-deploy §3.1) — no chunk.
            if (bundledServerBuild) return;
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
            let clean = normalizePath(id.split('?')[0]);
            // Out-of-root (scanned) modules arrive as /@fs/ URLs in dev —
            // strip back to the fs path so map keys match discovery's.
            // Mirrors Vite's fsPathFromId: the remainder may or may not carry
            // its own leading slash (`/@fs/C:/x`, `/@fs/home/x`, `/@fs//home/x`).
            if (clean.startsWith('/@fs/')) {
                clean = clean.slice('/@fs/'.length);
                if (!clean.startsWith('/') && !/^[a-zA-Z]:/.test(clean)) clean = '/' + clean;
            }
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
                    if (isClientOut(this)) {
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
                for (const warning of extraction.warnings) {
                    this.warn(`[sigx:server] ${relPath(clean)}: ${warning}`);
                }
                if (extraction.fns.length === 0) return null;
                const out = isClientOut(this) ? extraction.clientModule : extraction.ssrModule;
                return out ? { code: out, map: null } : null;
            }
            // Rolldown can run the transform more than once per module (scan
            // + build phases), the later pass over our OWN stub output —
            // never let that echo clobber the real extraction (the shared
            // registry cache feeds the SSR build). Match the exact generated
            // header, not any '@sigx/server/client' import — a real server
            // module may legitimately import the client entry.
            if (/^import \{ __server(?:FnStub|StreamStub|Only)/.test(code)) return null;
            // The incoming code is authoritative (dev edits arrive here before
            // any fs watcher) — re-extract and refresh the registry cache.
            const extraction = extractInto(clean, code);
            for (const warning of extraction?.warnings ?? []) {
                this.warn(`[sigx:server] ${relPath(clean)}: ${warning}`);
            }
            if (isClientOut(this)) {
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
            const key = normalizePath(file);
            if (filter(file)) {
                if (type === 'delete') extractions.delete(key);
                else extractInto(file, await read());
            } else if (type === 'delete') {
                if (!inline.delete(key)) return;
            } else {
                const code = await read();
                // Re-extract when the file is (or was) an inline carrier.
                if (!inline.has(key) && !inlineCandidate(file, code)) return;
                extractInlineInto(file, code);
            }
            const mod = this.environment.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
            if (mod) this.environment.moduleGraph.invalidateModule(mod);
        },

        configureServer(server) {
            // Out-of-root scanned packages are outside Vite's default watch
            // scope — add them so hotUpdate sees their edits.
            for (const dir of scanDirs()) server.watcher.add(dir);
            // A role:'client' build has no server — nothing to mount; its
            // functions live on the remote backend the stubs target.
            if (role === 'client') return;
            // Register the ambient-request seam EAGERLY (rfc-server §7 v1.1,
            // #309). In production the app's entry imports `@sigx/server/…`
            // when the server boots, so a document render is always scoped; in
            // dev the fn middleware below loads it lazily on the first RPC —
            // and a document request usually comes first, which would leave
            // SSR-time `rq.request` throwing in dev while working in prod.
            // That exact dev/prod divergence was #304.
            void server.ssrLoadModule('@sigx/server/node').catch((err: unknown) => {
                // "Not installed" is the EXPECTED miss (no @sigx/server in
                // this app's graph, or a version predating the entry): those
                // apps just keep the v1 detached-context behaviour. Any other
                // failure — a broken install, a throw inside the entry —
                // would otherwise leave SSR-time `rq.request` throwing with
                // no clue why, so it gets logged.
                const message = err instanceof Error ? err.message : String(err);
                const notInstalled =
                    (err as { code?: string } | null)?.code === 'ERR_MODULE_NOT_FOUND' ||
                    /Failed to (resolve|load) (import|url)|Cannot find (module|package)/.test(
                        message
                    );
                if (notInstalled) return;
                server.config.logger.warn(
                    `[sigx:server] could not load @sigx/server/node — server functions ` +
                    `called during SSR will not see the request: ${message}`
                );
            });
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
                const refreshModule = options.renderBoundaries
                    ? await devServer.ssrLoadModule(options.renderBoundaries)
                    : undefined;
                const renderBoundaries = refreshModule?.renderBoundaries as
                    import('@sigx/server/node').ServerFnHandlerOptions['renderBoundaries'];
                const handler = nodeEntry.createServerFnHandler({
                    base,
                    origin: options.origin,
                    maxBodyBytes: options.maxBodyBytes,
                    guard,
                    renderBoundaries,
                    resolve: async (symbol: string) => {
                        const record = findSymbol(symbol);
                        if (!record) return null;
                        const mod = await devServer.ssrLoadModule(devSpec(record.file));
                        return mod[record.exportName];
                    }
                });
                await handler(req, res, next);
            }
        }
    };
}
