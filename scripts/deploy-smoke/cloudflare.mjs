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
    assertFallthrough
} from './assertions.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

function build(filter) {
    console.log(`\n[deploy-smoke] building ${filter} (cloudflare)…`);
    execSync(`pnpm --filter ${filter} build:cloudflare`, { cwd: repoRoot, stdio: 'inherit' });
}

async function withWorker(exampleDir, run) {
    const cfg = JSON.parse(readFileSync(join(exampleDir, 'wrangler.jsonc'), 'utf-8'));
    const mf = new Miniflare({
        // Explicit single-module list: the bundle IS one self-contained file
        // (rfc-deploy §3.1), and Miniflare's automatic import walker rejects
        // variable-specifier dynamic import() expressions that exist as
        // never-invoked fallbacks (e.g. the islands pack's chunk-URL loader).
        modules: [{ type: 'ESModule', path: join(exampleDir, cfg.main) }],
        modulesRoot: join(exampleDir, 'dist-cf/server'),
        compatibilityDate: cfg.compatibility_date,
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
        await assertDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
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
        assert(!/via v\d/.test(data), `${label}: fn ran under workerd, not node (${data})`);
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
