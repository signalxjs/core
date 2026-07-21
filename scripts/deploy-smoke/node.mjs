// Deploy smoke, Node tier (rfc-deploy §6): the reference app's EXTERNAL
// build under `node --conditions production server.mjs` — the same
// assertion set as the workerd tier, which is the exit criterion made
// literal ("serves identically"). Runs on ubuntu AND windows.
//
// Run after `pnpm build`:  pnpm deploy-smoke:node
import { execSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const dir = join(repoRoot, 'examples/resume');
const PORT = Number(process.env.PORT) || 4319;
const ORIGIN = `http://localhost:${PORT}`;

console.log('\n[deploy-smoke] building @sigx/resume-example (node)…');
execSync('pnpm --filter @sigx/resume-example build', { cwd: repoRoot, stdio: 'inherit' });

console.log('[deploy-smoke] starting the production server…');
const child = spawn(
    process.execPath,
    ['--conditions', 'production', 'server.mjs'],
    {
        cwd: dir,
        env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
        // Inherit stdout too: a piped-but-never-drained stream fills its
        // buffer and deadlocks the child.
        stdio: ['ignore', 'inherit', 'inherit']
    }
);

async function waitForServer(url, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(url, { headers: { 'user-agent': 'deploy-smoke-probe' } });
            return;
        } catch {
            if (Date.now() > deadline) throw new Error(`server did not start within ${timeoutMs}ms`);
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}

try {
    await waitForServer(ORIGIN + '/');
    const fetchFn = (path, init) => fetch(ORIGIN + path, init);
    const label = 'node/resume';
    const resumeHtml = await assertDocument(fetchFn, {
        label,
        appMarker: 'SignalX resumability',
        ssrMarker: SSR_CONTEXT_MARKER
    });
    await assertBotDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
    await assertStaticAsset(fetchFn, { label, clientDir: join(dir, 'dist/client') });
    const data = await assertServerFn(fetchFn, {
        label,
        origin: ORIGIN,
        symbol: '@sigx/resume-example/src/api.server.ts#getQuote',
        args: [1],
        expectInData: 'Named = transferred.'
    });
    await assertCatalogGet(fetchFn, { label });
    await assertFormPost(fetchFn, { label, origin: ORIGIN, html: resumeHtml });
    assert(/via Node\.js/.test(data), `${label}: fn ran under node (${data})`);
    await assertFallthrough(fetchFn, { label });
    console.log('\n✅ deploy-smoke: the external build serves documents, assets, and server functions under node');
} catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
} finally {
    child.kill();
}
