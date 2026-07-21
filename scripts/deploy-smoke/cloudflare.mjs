// Deploy smoke, Cloudflare tier (rfc-deploy §6): the built worker under
// REAL workerd via Miniflare — programmatic dispatchFetch, no ports to
// configure, no login. Two apps:
//   examples/resume     — full composition: static → serverFn → document
//   examples/storefront — islands + resume attributes, no server-fns
//
// Run after `pnpm build`:  pnpm deploy-smoke:cloudflare
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import {
    assert,
    assertDocument,
    assertBotDocument,
    assertStaticAsset,
    assertServerFn,
    assertCatalogGet,
    assertFormPost,
    assertFallthrough,
    SSR_CONTEXT_MARKER
} from './assertions.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

function build(filter) {
    console.log(`\n[deploy-smoke] building ${filter} (cloudflare)…`);
    execSync(`pnpm --filter ${filter} build:cloudflare`, { cwd: repoRoot, stdio: 'inherit' });
}

/** Strip // and block comments outside strings — wrangler.jsonc is JSONC. */
function parseJsonc(source) {
    let out = '';
    let inString = false;
    for (let i = 0; i < source.length; i++) {
        const two = source.slice(i, i + 2);
        if (inString) {
            out += source[i];
            if (source[i] === '\\') {
                out += source[i + 1] ?? '';
                i++;
            } else if (source[i] === '"') inString = false;
        } else if (two === '//') {
            while (i < source.length && source[i] !== '\n') i++;
            out += '\n';
        } else if (two === '/*') {
            const end = source.indexOf('*/', i + 2);
            i = end === -1 ? source.length : end + 1;
        } else {
            if (source[i] === '"') inString = true;
            out += source[i];
        }
    }
    return JSON.parse(out);
}

async function withWorker(exampleDir, run) {
    const cfg = parseJsonc(readFileSync(join(exampleDir, 'wrangler.jsonc'), 'utf-8'));
    const mf = new Miniflare({
        // Explicit single-module list: the bundle IS one self-contained file
        // (rfc-deploy §3.1), and Miniflare's automatic import walker rejects
        // variable-specifier dynamic import() expressions that exist as
        // never-invoked fallbacks (e.g. the islands pack's chunk-URL loader).
        modules: [{ type: 'ESModule', path: join(exampleDir, cfg.main) }],
        modulesRoot: join(exampleDir, 'dist-cf/server'),
        compatibilityDate: cfg.compatibility_date,
        // The app's flags, not a hard-coded set — the smoke must run workerd
        // configured the way the deployment is. `nodejs_compat` is what makes
        // node:async_hooks (the ambient request scope, rfc-server §7 v1.1)
        // resolvable; without this line the worker fails to start.
        compatibilityFlags: cfg.compatibility_flags ?? [],
        assets: {
            directory: join(exampleDir, cfg.assets.directory),
            routerConfig: { has_user_worker: true },
            assetConfig: { html_handling: cfg.assets.html_handling ?? 'none' }
        }
    });
    try {
        const fetchFn = (path, init) => mf.dispatchFetch('http://localhost' + path, init);
        await run(fetchFn, join(exampleDir, cfg.assets.directory));
    } finally {
        // ALWAYS: an undisposed workerd process keeps CI alive forever.
        await mf.dispose();
    }
}

try {
// ---------------------------------------------------------------------------
// 1) resume — the reference app: document + asset + server-fn + fallthrough.
// ---------------------------------------------------------------------------
{
    const dir = join(repoRoot, 'examples/resume');
    build('@sigx/resume-example');
    await withWorker(dir, async (fetchFn, clientDir) => {
        const label = 'workerd/resume';
        const resumeHtml = await assertDocument(fetchFn, {
            label,
            appMarker: 'SignalX resumability',
            ssrMarker: SSR_CONTEXT_MARKER
        });
        await assertBotDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
        await assertStaticAsset(fetchFn, { label, clientDir });
        const data = await assertServerFn(fetchFn, {
            label,
            origin: 'http://localhost',
            // The deterministic stable symbol (rev 2): package name +
            // package-relative path + '#' + export.
            symbol: '@sigx/resume-example/src/api.server.ts#getQuote',
            args: [1],
            expectInData: 'Named = transferred.'
        });
        await assertCatalogGet(fetchFn, { label });
        await assertFormPost(fetchFn, { label, origin: 'http://localhost', html: resumeHtml });
        assert(/via Cloudflare-Workers/.test(data), `${label}: fn ran under workerd, not node (${data})`);
        await assertFallthrough(fetchFn, { label });
    });
}

// ---------------------------------------------------------------------------
// 2) storefront — islands + resume attributes serve identically (no fns).
// ---------------------------------------------------------------------------
{
    const dir = join(repoRoot, 'examples/storefront');
    build('@sigx/storefront-example');
    await withWorker(dir, async (fetchFn, clientDir) => {
        const label = 'workerd/storefront';
        const html = await assertDocument(fetchFn, { label, appMarker: 'SignalX Storefront' });
        assert(html.includes('data-sigx-b'), `${label}: boundary attributes rendered`);
        assert(
            /"hydrate":"(visible|idle|interaction)"/.test(html),
            `${label}: island hydration strategies in the boundary table`
        );
        await assertStaticAsset(fetchFn, { label, clientDir });
        await assertFallthrough(fetchFn, { label });
    });
}

console.log('\n✅ deploy-smoke: the built workers serve documents, assets, and server functions under real workerd');
} catch (err) {
    // Reached only after withWorker's finally has disposed workerd.
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
}
