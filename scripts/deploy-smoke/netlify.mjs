// Deploy smoke, Netlify tier (rfc-deploy §6): STRUCTURAL verification, not
// emulation — assert the generated Frameworks API layout, then run the SAME
// shared assertion set through a fetchFn that mirrors Netlify's routing
// (`preferStatic`: CDN files from the publish dir win; the catch-all
// function runs otherwise), invoking the generated function's default
// export directly under Node (a pure fetch handler; `context` is optional
// sugar it never touches).
//
// Run after `pnpm build`:  pnpm deploy-smoke:netlify
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
    assert,
    assertDocument,
    assertBotDocument,
    assertStaticAsset,
    assertServerFn,
    assertFallthrough,
    SSR_CONTEXT_MARKER
} from './assertions.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');
const dir = join(repoRoot, 'examples/resume');
const fnDir = join(dir, '.netlify/v1/functions/sigx-ssr');
const publishDir = join(dir, 'dist-netlify/client');

console.log('\n[deploy-smoke] building @sigx/resume-example (netlify)…');
execSync('pnpm --filter @sigx/resume-example build:netlify', { cwd: repoRoot, stdio: 'inherit' });

try {
    // ------------------------------------------------------------------
    // 1) Structural: the generated Frameworks API layout.
    // ------------------------------------------------------------------
    const label = 'netlify/resume';
    assert(existsSync(join(fnDir, 'sigx-ssr.mjs')), `${label}: function file generated`);
    assert(
        JSON.parse(readFileSync(join(fnDir, 'package.json'), 'utf-8')).type === 'module',
        `${label}: function dir is ESM (package.json type module)`
    );
    assert(
        !existsSync(join(publishDir, 'index.html')),
        `${label}: publish dir does not shadow '/' with the raw template`
    );

    const mod = await import(pathToFileURL(join(fnDir, 'sigx-ssr.mjs')).href);
    assert(typeof mod.default === 'function', `${label}: default export is the v2 fetch handler`);
    assert(mod.config?.path === '/*', `${label}: config.path is the catch-all`);
    assert(mod.config?.preferStatic === true, `${label}: config.preferStatic lets CDN files win`);
    assert(mod.config?.nodeBundler === 'none', `${label}: output declared final (nodeBundler none)`);

    // ------------------------------------------------------------------
    // 2) Behavioral: preferStatic semantics over the publish dir, then the
    //    function — the same assertion set as every other tier.
    // ------------------------------------------------------------------
    const ORIGIN = 'http://localhost';
    const fetchFn = async (urlPath, init) => {
        const pathname = new URL(ORIGIN + urlPath).pathname;
        const method = (init?.method ?? 'GET').toUpperCase();
        // preferStatic: a matching CDN file wins (GET/HEAD — the CDN never
        // answers POSTs with files).
        if (method === 'GET' || method === 'HEAD') {
            const file = join(publishDir, pathname.slice(1));
            if (pathname !== '/' && existsSync(file) && statSync(file).isFile()) {
                const type = file.endsWith('.js')
                    ? 'text/javascript'
                    : file.endsWith('.css')
                      ? 'text/css'
                      : 'application/octet-stream';
                return new Response(readFileSync(file), { headers: { 'content-type': type } });
            }
        }
        return mod.default(new Request(ORIGIN + urlPath, init));
    };

    await assertDocument(fetchFn, {
        label,
        appMarker: 'SignalX resumability',
        ssrMarker: SSR_CONTEXT_MARKER
    });
    await assertBotDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
    await assertStaticAsset(fetchFn, { label, clientDir: publishDir });
    const data = await assertServerFn(fetchFn, {
        label,
        origin: ORIGIN,
        symbol: '@sigx/resume-example/src/api.server.ts#getQuote',
        args: [1],
        expectInData: 'Named = transferred.'
    });
    assert(/via Node\.js/.test(data), `${label}: fn ran under the Node runtime (${data})`);
    await assertFallthrough(fetchFn, { label });

    console.log('\n✅ deploy-smoke: the generated Netlify function + publish dir are spec-shaped and serve documents, assets, and server functions');
} catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
}
