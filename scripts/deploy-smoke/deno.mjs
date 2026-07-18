// Deploy smoke, Deno tier (rfc-deploy §6): the BUNDLED build (Deno cannot
// select custom export conditions, so the prod dists are baked in at build
// time) under `deno run`, with the same assertion set as every other tier.
//
// Run after `pnpm build`:  pnpm deploy-smoke:deno   (requires deno)
import { execSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assert,
    assertDocument,
    assertBotDocument,
    assertStaticAsset,
    assertServerFn,
    assertFallthrough
} from './assertions.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');
const dir = join(repoRoot, 'examples/resume');
const PORT = Number(process.env.PORT) || 4323;
const ORIGIN = `http://localhost:${PORT}`;

console.log('\n[deploy-smoke] building @sigx/resume-example (deno, bundled)…');
execSync('pnpm --filter @sigx/resume-example build:deno', { cwd: repoRoot, stdio: 'inherit' });

console.log('[deploy-smoke] starting the deno production server…');
// No shell wrapper: deno is a real executable, and killing a cmd.exe
// wrapper on Windows would orphan the server (which then holds the
// inherited stdio pipes open forever).
const child = spawn(
    'deno',
    ['run', '--allow-net', '--allow-read', '--allow-env', 'dist-deno/server/entry.deno.js'],
    {
        cwd: dir,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'inherit', 'inherit']
    }
);

function stop() {
    if (process.platform === 'win32') {
        // Kill the TREE — child.kill() alone leaves grandchildren alive.
        try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch { /* gone */ }
    } else {
        child.kill();
    }
}

async function waitForServer(url, timeoutMs = 30000) {
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
    // Generous window: first run fetches the jsr:@std/http package.
    await waitForServer(ORIGIN + '/');
    const fetchFn = (path, init) => fetch(ORIGIN + path, init);
    const label = 'deno/resume';
    await assertDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
    await assertBotDocument(fetchFn, { label, appMarker: 'SignalX resumability' });
    await assertStaticAsset(fetchFn, { label, clientDir: join(dir, 'dist-deno/client') });
    const data = await assertServerFn(fetchFn, {
        label,
        origin: ORIGIN,
        symbol: '@sigx/resume-example/src/api.server.ts#getQuote',
        args: [1],
        expectInData: 'Named = transferred.'
    });
    // Deno's node-compat process.version — proof the fn executed server-side.
    assert(/via v\d/.test(data), `${label}: fn reported a runtime version (${data})`);
    await assertFallthrough(fetchFn, { label });
    console.log('\n✅ deploy-smoke: the bundled build serves documents, assets, and server functions under deno');
} catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
} finally {
    stop();
}
