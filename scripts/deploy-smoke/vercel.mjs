// Deploy smoke, Vercel tier (rfc-deploy §6): STRUCTURAL verification, not
// emulation — assert the generated Build Output API v3 layout, then run the
// SAME shared assertion set through a fetchFn that mirrors config.json's
// route phases: the server-fn route first, the filesystem handle (files
// from static/) second, the catch-all to the render function last — whose
// fetch export is invoked DIRECTLY under Node (it is WinterCG code; this is
// exactly what Vercel's launcher calls). Live-deploy canaries are out of CI
// scope per the RFC.
//
// Run after `pnpm build`:  pnpm deploy-smoke:vercel
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
const output = join(dir, '.vercel/output');

console.log('\n[deploy-smoke] building @sigx/resume-example (vercel)…');
execSync('pnpm --filter @sigx/resume-example build:vercel', { cwd: repoRoot, stdio: 'inherit' });

try {
    // ------------------------------------------------------------------
    // 1) Structural: the generated layout is spec-shaped.
    // ------------------------------------------------------------------
    const label = 'vercel/resume';
    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf-8'));
    assert(config.version === 3, `${label}: config.json version 3`);
    const [fnRoute, fsHandle, catchAll] = config.routes;
    assert(
        fnRoute.src === '/_sigx/fn/(.*)' && fnRoute.dest === '/_render',
        `${label}: server-fn route precedes the filesystem handle`
    );
    assert(fsHandle.handle === 'filesystem', `${label}: filesystem handle present`);
    assert(
        catchAll.src === '/(.*)' && catchAll.dest === '/_render',
        `${label}: catch-all to the render function after the filesystem`
    );
    const vcConfig = JSON.parse(
        readFileSync(join(output, 'functions/_render.func/.vc-config.json'), 'utf-8')
    );
    assert(/^nodejs\d+\.x$/.test(vcConfig.runtime), `${label}: node runtime (${vcConfig.runtime})`);
    assert(
        existsSync(join(output, 'functions/_render.func', vcConfig.handler)) &&
            vcConfig.launcherType === 'Nodejs',
        `${label}: launcher config (handler ${vcConfig.handler} exists)`
    );
    assert(vcConfig.supportsResponseStreaming === true, `${label}: response streaming enabled`);
    assert(
        !existsSync(join(output, 'static/index.html')),
        `${label}: static/ does not shadow '/' with the raw template`
    );
    assert(
        !existsSync(join(output, 'static/.vite')),
        `${label}: build manifests are not public static files`
    );

    // ------------------------------------------------------------------
    // 2) Behavioral: the function's fetch export, invoked as the launcher
    //    would, behind a fetchFn that mirrors the route phases.
    // ------------------------------------------------------------------
    const fn = (
        await import(pathToFileURL(join(output, 'functions/_render.func', vcConfig.handler)).href)
    ).default;
    assert(typeof fn?.fetch === 'function', `${label}: default export has the fetch METHOD (web handler shape)`);

    const ORIGIN = 'http://localhost';
    const fetchFn = async (urlPath, init) => {
        const pathname = new URL(ORIGIN + urlPath).pathname;
        // Phase 1: main routes before the filesystem handle.
        if (!/^\/_sigx\/fn\//.test(pathname)) {
            // Phase 2: the filesystem handle — files from static/.
            const file = join(output, 'static', pathname.slice(1));
            if (pathname !== '/' && existsSync(file) && statSync(file).isFile()) {
                const type = file.endsWith('.js')
                    ? 'text/javascript'
                    : file.endsWith('.css')
                      ? 'text/css'
                      : 'application/octet-stream';
                return new Response(readFileSync(file), { headers: { 'content-type': type } });
            }
        }
        // Phase 3 (or the fn route): the render function.
        return fn.fetch(new Request(ORIGIN + urlPath, init));
    };

    await assertDocument(fetchFn, {
        label,
        appMarker: 'SignalX resumability',
        ssrMarker: SSR_CONTEXT_MARKER
    });
    await assertBotDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
    await assertStaticAsset(fetchFn, { label, clientDir: join(dir, 'dist-vercel/client') });
    const data = await assertServerFn(fetchFn, {
        label,
        origin: ORIGIN,
        symbol: '@sigx/resume-example/src/api.server.ts#getQuote',
        args: [1],
        expectInData: 'Named = transferred.'
    });
    assert(/via Node\.js/.test(data), `${label}: fn ran under the Node runtime (${data})`);
    await assertFallthrough(fetchFn, { label });

    console.log('\n✅ deploy-smoke: the generated .vercel/output is spec-shaped and serves documents, assets, and server functions');
} catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
}
