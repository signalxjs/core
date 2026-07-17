/**
 * @sigx/cloudflare — the flagship deployment adapter (rfc-deploy §4.2).
 *
 * A pack in the established sense: rides the public `SigxAdapter` seam of
 * `@sigx/vite` with no privileged access. The runtime story is
 * `createFetchHandler` (already WinterCG-clean, CI-enforced); everything
 * here is BUILD glue — a fully bundled workerd-conditioned server build,
 * a starter `wrangler.jsonc`, the scaffolded platform entry, and dev
 * binding proxies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    SigxAdapter,
    AdapterGenerateContext,
    AdapterSetupContext
} from '@sigx/vite';
import { scaffoldEntry } from './scaffold.js';
import { attachDevPlatform, type DevPlatform } from './dev.js';

export { getDevPlatform, type DevPlatform } from './dev.js';

export interface CloudflareAdapterOptions {
    /** Platform entry (project-relative). Default `'src/entry.cloudflare.ts'`. */
    entry?: string;

    /**
     * Boot wrangler's `getPlatformProxy()` on the dev server and expose it
     * via `getDevPlatform(server)` — local KV/D1/R2 simulations for
     * binding-reliant apps (rfc-deploy §4.6). Requires `wrangler` as a dev
     * dependency. Default `false`.
     */
    devProxy?: boolean;

    /**
     * `compatibility_date` written into a SCAFFOLDED `wrangler.jsonc`.
     * Pinned (not "today") so builds are deterministic; an existing config
     * is never touched. Default: a constant bumped per release.
     */
    compatibilityDate?: string;
}

const DEFAULT_ENTRY = 'src/entry.cloudflare.ts';
/** Bumped deliberately per release, never derived from the clock. */
const DEFAULT_COMPAT_DATE = '2026-07-01';

const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Any string → a wrangler-safe worker name slug. */
function slugify(value: string): string {
    return value.replace(/^@/, '').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

/** Root package.json name → a wrangler-safe worker name. */
function workerName(root: string): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
            name?: string;
        };
        if (pkg.name) {
            const slug = slugify(pkg.name);
            if (slug) return slug;
        }
    } catch {
        // fall through to the directory name
    }
    return slugify(path.basename(root)) || 'sigx-app';
}

/**
 * The import specifier a scaffolded entry uses for the app's SSR entry.
 * Both inputs are PROJECT-relative — computed with posix path math on the
 * normalized strings, never `path.relative` (which resolves against
 * process.cwd() and breaks when the builder runs from another directory).
 */
function relEntryImport(platformEntry: string, ssrEntry: string): string {
    const norm = (p: string) => toPosix(p).replace(/^\//, '');
    const rel = path.posix
        .relative(path.posix.dirname(norm(platformEntry)), norm(ssrEntry))
        .replace(/\.(tsx|ts|jsx|mjs|js)$/, '');
    return rel.startsWith('.') ? rel : './' + rel;
}

export function cloudflare(options: CloudflareAdapterOptions = {}): SigxAdapter {
    const entry = options.entry ?? DEFAULT_ENTRY;

    return {
        name: 'cloudflare',
        // Total by design (rfc-deploy §3.1): one bundle IS one module graph
        // — workerd cannot resolve bare imports at runtime.
        serverBuild: 'bundled',
        // REPLACEMENT array: 'node' is deliberately absent — the render
        // path is node:-free by CI guarantee, and workerd should prove it.
        conditions: ['workerd', 'worker'],
        runtimeExternal: [/^cloudflare:/],
        entry,

        setup(ctx: AdapterSetupContext) {
            const file = path.resolve(ctx.root, entry);
            // Scaffold iff absent, then NEVER touch — user-owned from the
            // first write (PR #322's convention).
            if (fs.existsSync(file)) return;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, scaffoldEntry(relEntryImport(entry, ctx.ssrEntry)));
            ctx.logger.info(
                `[sigx:cloudflare] scaffolded ${entry} - the file is yours from here on ` +
                `(rebuilds never touch it).`
            );
        },

        generate(ctx: AdapterGenerateContext) {
            // The built worker: rolldown names the single ssr input
            // [name].js. Verified against the output tree; warn if the
            // convention ever drifts.
            let mainFile = path.parse(ctx.ssrInput).name + '.js';
            if (!fs.existsSync(path.join(ctx.serverOutDir, mainFile))) {
                const candidates = fs.existsSync(ctx.serverOutDir)
                    ? fs.readdirSync(ctx.serverOutDir).filter((f) => f.endsWith('.js'))
                    : [];
                if (candidates.length === 1) {
                    ctx.logger.warn(
                        `[sigx:cloudflare] expected ${mainFile} in the server outDir but found ` +
                        `${candidates[0]} - using it as the worker entry.`
                    );
                    mainFile = candidates[0];
                } else {
                    ctx.logger.warn(
                        `[sigx:cloudflare] could not identify the built worker entry in ` +
                        `${ctx.serverOutDir} - wrangler.jsonc 'main' may need fixing by hand.`
                    );
                }
            }
            const main = toPosix(path.relative(ctx.root, path.join(ctx.serverOutDir, mainFile)));
            const assetsDir = toPosix(path.relative(ctx.root, ctx.clientOutDir));
            const configFile = path.join(ctx.root, 'wrangler.jsonc');

            if (!fs.existsSync(configFile)) {
                // Starter config, written ONCE (comment-free JSON — valid
                // JSONC, and JSON.parse-able by tooling).
                // html_handling 'none' is load-bearing: the client outDir
                // contains index.html (the raw outlet template), and the
                // default auto-trailing-slash handling would serve it for
                // GET / BEFORE the worker runs. 'none' limits the asset
                // router to exact file paths, so documents reach the worker.
                const config = {
                    name: workerName(ctx.root),
                    main,
                    compatibility_date: options.compatibilityDate ?? DEFAULT_COMPAT_DATE,
                    assets: { directory: assetsDir, html_handling: 'none' }
                };
                fs.writeFileSync(configFile, JSON.stringify(config, null, 4) + '\n');
                ctx.logger.info(
                    `[sigx:cloudflare] wrote wrangler.jsonc (main: ${main}) - the config is ` +
                    `yours from here on. Deploy with: wrangler deploy`
                );
                return;
            }

            // Present: validate (best-effort substring checks — real configs
            // carry comments, so no strict parse), warn on drift, never write.
            const raw = fs.readFileSync(configFile, 'utf-8');
            if (!raw.includes(main)) {
                ctx.logger.warn(
                    `[sigx:cloudflare] wrangler.jsonc does not mention the built worker entry ` +
                    `(${main}) - did 'main' drift from the build output?`
                );
            }
            if (!raw.includes(assetsDir)) {
                ctx.logger.warn(
                    `[sigx:cloudflare] wrangler.jsonc does not mention the client outDir ` +
                    `(${assetsDir}) - did assets.directory drift?`
                );
            }
            if (!raw.includes('html_handling')) {
                ctx.logger.warn(
                    `[sigx:cloudflare] wrangler.jsonc sets no assets.html_handling - with the ` +
                    `default handling the raw index.html template is served for GET / before ` +
                    `the worker runs. Set "html_handling": "none" (or route with run_worker_first).`
                );
            }
        },

        ...(options.devProxy && {
            async dev(server) {
                let getPlatformProxy: (() => Promise<DevPlatform>) | undefined;
                try {
                    ({ getPlatformProxy } = (await import('wrangler')) as unknown as {
                        getPlatformProxy: () => Promise<DevPlatform>;
                    });
                } catch {
                    throw new Error(
                        `[sigx:cloudflare] devProxy: true requires wrangler as a dev dependency ` +
                        `(pnpm add -D wrangler).`
                    );
                }
                attachDevPlatform(server, await getPlatformProxy());
            }
        })
    };
}
