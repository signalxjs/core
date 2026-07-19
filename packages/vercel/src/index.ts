/**
 * @sigx/vercel — the Vercel deployment adapter (rfc-deploy §4.4).
 *
 * A pack riding `@sigx/vite`'s public `SigxAdapter` seam. Unlike
 * wrangler-style tools, Vercel's Build Output API v3 IS a generation
 * contract — hand-writing `.vercel/output` has no copyability value — so
 * `generate()` produces the FULL layout every build (static/, the render
 * function, config.json routes) and overwrites it. The platform entry stays
 * user-authored (scaffolded iff absent, the wrangler.jsonc posture).
 *
 * Deploy: `vercel deploy --prebuilt` (the project must be linked).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    SigxAdapter,
    AdapterGenerateContext,
    AdapterSetupContext
} from '@sigx/vite';
import { scaffoldEntry, edgeWrapper } from './scaffold.js';

export interface VercelAdapterOptions {
    /**
     * Function runtime. Default `'node'` — Vercel's own current guidance
     * ("we recommend migrating from edge to Node.js"; both run on Fluid
     * compute). `'edge'` stays available as the opt-in.
     */
    runtime?: 'node' | 'edge';

    /** Platform entry (project-relative). Default `'src/entry.vercel.ts'`. */
    entry?: string;

    /**
     * Node runtime version string for `.vc-config.json`. Default
     * `'nodejs22.x'`. Ignored for `runtime: 'edge'`.
     */
    nodeVersion?: string;
}

const DEFAULT_ENTRY = 'src/entry.vercel.ts';
const DEFAULT_NODE_VERSION = 'nodejs22.x';
/** The one render function; `.func` is stripped from the URL → `/_render`. */
const FN_NAME = '_render';

/** Recursive copy that skips entries the static tier must not serve. */
function copyStatic(from: string, to: string, skipRootEntries: Set<string>): number {
    let copied = 0;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (skipRootEntries.has(entry.name)) continue;
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copied += copyStatic(src, dest, new Set());
        } else {
            fs.copyFileSync(src, dest);
            copied++;
        }
    }
    return copied;
}

export function vercel(options: VercelAdapterOptions = {}): SigxAdapter {
    const runtime = options.runtime ?? 'node';
    const entry = options.entry ?? DEFAULT_ENTRY;

    return {
        name: 'vercel',
        // Total by design (rfc-deploy §3.1): one bundle IS one module graph.
        // The Node runtime still bundles — Vercel functions upload the .func
        // dir contents, not node_modules.
        serverBuild: 'bundled',
        conditions: runtime === 'edge' ? ['edge-light', 'worker'] : ['node'],
        entry,

        setup(ctx: AdapterSetupContext) {
            const file = path.resolve(ctx.root, entry);
            // Scaffold iff absent, then NEVER touch — user-owned from the
            // first write (the PR #322 convention).
            if (fs.existsSync(file)) return;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const rel = toPosix(
                path.posix
                    .relative(
                        path.posix.dirname(toPosix(entry).replace(/^\//, '')),
                        toPosix(ctx.ssrEntry).replace(/^\//, '')
                    )
                    .replace(/\.(tsx|ts|jsx|mjs|js)$/, '')
            );
            fs.writeFileSync(file, scaffoldEntry(rel.startsWith('.') ? rel : './' + rel));
            ctx.logger.info(
                `[sigx:vercel] scaffolded ${entry} - the file is yours from here on ` +
                `(rebuilds never touch it).`
            );
        },

        generate(ctx: AdapterGenerateContext) {
            // The bundled entry: rolldown names the single ssr input [name].js.
            let builtEntry = path.parse(ctx.ssrInput).name + '.js';
            if (!fs.existsSync(path.join(ctx.serverOutDir, builtEntry))) {
                const candidates = fs.existsSync(ctx.serverOutDir)
                    ? fs.readdirSync(ctx.serverOutDir).filter((f) => f.endsWith('.js'))
                    : [];
                if (candidates.length === 1) {
                    builtEntry = candidates[0];
                } else {
                    throw new Error(
                        `[sigx:vercel] could not identify the built function entry in ${ctx.serverOutDir}.`
                    );
                }
            }

            // The Build Output API layout is GENERATED, fully, every build.
            const output = path.join(ctx.root, '.vercel', 'output');
            fs.rmSync(output, { recursive: true, force: true });
            const staticDir = path.join(output, 'static');
            const funcDir = path.join(output, 'functions', `${FN_NAME}.func`);
            fs.mkdirSync(funcDir, { recursive: true });

            // static/: the client outDir minus index.html — the filesystem
            // handle serves static/index.html for '/', which would shadow
            // the document render with the raw outlet template — and minus
            // .vite/ (build manifests are not public assets).
            const copied = copyStatic(ctx.clientOutDir, staticDir, new Set(['index.html', '.vite']));

            // The function: the WHOLE server outDir — the entry is usually a
            // single self-contained bundle, but code-split sibling chunks
            // (dynamic imports) must ride along or the deployed function
            // fails with missing-module errors. Everything under .func is
            // uploaded recursively; a package.json makes the .js files ESM
            // (renaming files would break relative chunk imports).
            copyStatic(ctx.serverOutDir, funcDir, new Set());
            fs.writeFileSync(path.join(funcDir, 'package.json'), '{"type":"module"}\n');
            if (runtime === 'edge') {
                // Edge entrypoints are bare default fetch fns — wrap the
                // user's { fetch } export.
                fs.writeFileSync(path.join(funcDir, '_sigx_edge.js'), edgeWrapper(builtEntry));
                fs.writeFileSync(
                    path.join(funcDir, '.vc-config.json'),
                    JSON.stringify({ runtime: 'edge', entrypoint: '_sigx_edge.js' }, null, 4) + '\n'
                );
            } else {
                // Node runtime: the launcher detects a WEB handler by the
                // `fetch` METHOD on the default export — which is exactly
                // the entry's shape, so the built entry IS the handler.
                fs.writeFileSync(
                    path.join(funcDir, '.vc-config.json'),
                    JSON.stringify(
                        {
                            runtime: options.nodeVersion ?? DEFAULT_NODE_VERSION,
                            handler: builtEntry,
                            launcherType: 'Nodejs',
                            shouldAddHelpers: false,
                            supportsResponseStreaming: true
                        },
                        null,
                        4
                    ) + '\n'
                );
            }

            // config.json: the composition order as routes — the server-fn
            // prefix BEFORE the filesystem handle (POSTs must never be
            // shadowed by files), statics from the filesystem, then the
            // catch-all to the render function.
            fs.writeFileSync(
                path.join(output, 'config.json'),
                JSON.stringify(
                    {
                        version: 3,
                        routes: [
                            { src: '/_sigx/fn/(.*)', dest: `/${FN_NAME}` },
                            { handle: 'filesystem' },
                            { src: '/(.*)', dest: `/${FN_NAME}` }
                        ]
                    },
                    null,
                    4
                ) + '\n'
            );

            ctx.logger.info(
                `[sigx:vercel] wrote .vercel/output (${runtime} runtime, ${copied} static files). ` +
                `Deploy with: vercel deploy --prebuilt`
            );
        }
    };
}

const toPosix = (p: string): string => p.replace(/\\/g, '/');
