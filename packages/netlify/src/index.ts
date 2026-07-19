/**
 * @sigx/netlify — the Netlify deployment adapter (rfc-deploy §4.5). The
 * last platform phase, same shape as `@sigx/vercel` once it proved the
 * generation pattern.
 *
 * A pack riding `@sigx/vite`'s public `SigxAdapter` seam. `generate()`
 * emits the Frameworks API layout (`.netlify/v1/functions/` — Netlify's
 * recommended target for build-tool adapters): ONE catch-all SSR function
 * (Functions v2 fetch contract, `preferStatic: true` so CDN files win)
 * carrying the fully bundled server. The publish dir stays the client
 * outDir, configured by a starter `netlify.toml` that is PRINTED, never
 * written — the config stays user-owned from the first character.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type {
    SigxAdapter,
    AdapterGenerateContext,
    AdapterSetupContext
} from '@sigx/vite';
import { scaffoldEntry, functionWrapper } from './scaffold.js';

export interface NetlifyAdapterOptions {
    /** Platform entry (project-relative). Default `'src/entry.netlify.ts'`. */
    entry?: string;
}

const DEFAULT_ENTRY = 'src/entry.netlify.ts';
/** Prefixed so a generated function never collides with user functions. */
const FN_NAME = 'sigx-ssr';

function packageVersion(): string {
    try {
        const require = createRequire(import.meta.url);
        return (require('../package.json') as { version: string }).version;
    } catch {
        return '0.0.0';
    }
}

/** Recursive copy (everything — the function dir ships as-is). */
function copyDir(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dest);
        else fs.copyFileSync(src, dest);
    }
}

export function netlify(options: NetlifyAdapterOptions = {}): SigxAdapter {
    const entry = options.entry ?? DEFAULT_ENTRY;

    return {
        name: 'netlify',
        // Total by design (rfc-deploy §3.1): one bundle IS one module graph.
        // Functions run on Node (Lambda) — but the output must be
        // self-contained: node_modules is not uploaded with the .netlify/v1
        // channel and `nodeBundler: 'none'` ships the dir as-is.
        serverBuild: 'bundled',
        conditions: ['node'],
        entry,

        setup(ctx: AdapterSetupContext) {
            const file = path.resolve(ctx.root, entry);
            // Scaffold iff absent, then NEVER touch (the PR #322 convention).
            if (fs.existsSync(file)) return;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const toPosix = (p: string) => p.replace(/\\/g, '/');
            const rel = path.posix
                .relative(
                    path.posix.dirname(toPosix(entry).replace(/^\//, '')),
                    toPosix(ctx.ssrEntry).replace(/^\//, '')
                )
                .replace(/\.(tsx|ts|jsx|mjs|js)$/, '');
            fs.writeFileSync(file, scaffoldEntry(rel.startsWith('.') ? rel : './' + rel));
            ctx.logger.info(
                `[sigx:netlify] scaffolded ${entry} - the file is yours from here on ` +
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
                        `[sigx:netlify] could not identify the built function entry in ${ctx.serverOutDir}.`
                    );
                }
            }

            // The Frameworks API channel is GENERATED, fully, every build.
            // Function-as-directory: functions/<name>/<name>.mjs, with the
            // whole server output riding along (code-split chunks included)
            // and a package.json making the .js chunks ESM.
            const fnDir = path.join(ctx.root, '.netlify', 'v1', 'functions', FN_NAME);
            fs.rmSync(fnDir, { recursive: true, force: true });
            copyDir(ctx.serverOutDir, fnDir);
            fs.writeFileSync(path.join(fnDir, 'package.json'), '{"type":"module"}\n');
            fs.writeFileSync(
                path.join(fnDir, `${FN_NAME}.mjs`),
                functionWrapper(builtEntry, packageVersion())
            );

            // The publish dir IS the client outDir — but its index.html is
            // the raw outlet template, and with `preferStatic` the CDN would
            // serve it for '/' BEFORE the function runs (the same shadowing
            // Vercel's filesystem handle has). The template is already
            // inlined into the bundle (virtual:sigx-app), so remove the file
            // from this adapter-owned output tree.
            fs.rmSync(path.join(ctx.clientOutDir, 'index.html'), { force: true });

            const publish = path.relative(ctx.root, ctx.clientOutDir).replace(/\\/g, '/');
            const tomlPath = path.join(ctx.root, 'netlify.toml');
            if (!fs.existsSync(tomlPath)) {
                // PRINTED, never written (rfc-deploy §4.5) — the config is
                // user-owned from its first character.
                ctx.logger.info(
                    `[sigx:netlify] wrote .netlify/v1/functions/${FN_NAME}. No netlify.toml found - ` +
                    `create one with:\n\n` +
                    `[build]\n` +
                    `  publish = "${publish}"\n` +
                    `  command = "npm run build"   # must produce ${publish} AND .netlify/v1/\n\n` +
                    `Then deploy with: netlify deploy --prod (or --no-build for prebuilt output).`
                );
                return;
            }
            const raw = fs.readFileSync(tomlPath, 'utf-8');
            if (!raw.includes(publish)) {
                ctx.logger.warn(
                    `[sigx:netlify] netlify.toml does not mention the client outDir (${publish}) - ` +
                    `is [build].publish pointing at the right directory?`
                );
            }
            ctx.logger.info(
                `[sigx:netlify] wrote .netlify/v1/functions/${FN_NAME}. ` +
                `Deploy with: netlify deploy --prod (or --no-build for prebuilt output).`
            );
        }
    };
}
