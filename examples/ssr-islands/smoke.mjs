// Browser smoke for the islands example — the LAZY HYDRATION RUNTIME proof
// (#293). Requires a prior prod build:
//
//   pnpm build                                   # workspace dists
//   pnpm --filter @sigx/ssr-islands-example build
//   node smoke.mjs
//
// Coverage-based (EXECUTION, not fetches — the document modulepreloads the
// runtime chunk deliberately, so fetch-based assertions would prove
// nothing): on /?deferred no island strategy can fire at load, and the sigx
// runtime chunk must not EXECUTE until the first interaction wakes an
// island.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 4174;
const here = fileURLToPath(new URL('.', import.meta.url));

function assert(cond, message) {
    if (!cond) {
        throw new Error(`❌ islands-smoke: ${message}`);
    }
    console.log(`✔ ${message}`);
}

async function waitForServer(url, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`❌ islands-smoke: server did not come up on ${url}`);
}

// ---- Build-shape assertions (no browser needed) ------------------------
// The islands manifest v2 names the runtime chunks; Vite's client manifest
// proves the entry's transitive STATIC closure excludes them — the runtime
// is reachable only through dynamic imports.
const islandsManifest = JSON.parse(
    readFileSync(new URL('./dist/client/.vite/sigx-islands-manifest.json', import.meta.url), 'utf-8')
);
assert(islandsManifest.version === 2, 'islands manifest is v2');
const runtimePreload = islandsManifest.runtimePreload ?? [];
assert(runtimePreload.length > 0, `manifest names the lazy runtime chunks (${runtimePreload.join(', ')})`);

const viteManifest = JSON.parse(
    readFileSync(new URL('./dist/client/.vite/manifest.json', import.meta.url), 'utf-8')
);
const entryKey = Object.keys(viteManifest).find((k) => viteManifest[k].isEntry);
const staticClosure = new Set();
const walk = (key) => {
    if (!key || staticClosure.has(key)) return;
    staticClosure.add(key);
    for (const dep of viteManifest[key]?.imports ?? []) walk(dep);
};
walk(entryKey);
const staticFiles = new Set([...staticClosure].map((k) => '/' + viteManifest[k].file));
for (const chunk of runtimePreload) {
    assert(!staticFiles.has(chunk), `runtime chunk ${chunk} is NOT in the entry's static import closure`);
}

// ---- Behavioral proof (CDP precise coverage) ---------------------------
const server = spawn(
    process.execPath,
    ['--conditions', 'production', 'server.mjs'],
    {
        cwd: here,
        env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
        stdio: 'ignore'
    }
);

try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = await chromium.launch();
    try {
        // A REAL-Chrome UA: HeadlessChrome matches server.mjs's isBot regex
        // and would get the blocking document instead of the human path.
        const page = await browser.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
        });
        page.on('pageerror', (e) => console.error('[pageerror]', e.message));
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
        const executed = async () => {
            const { result } = await cdp.send('Profiler.takePreciseCoverage');
            return result
                .map((e) => { try { return new URL(e.url).pathname; } catch { return ''; } })
                .filter((p) => p.startsWith('/assets/'));
        };
        const runtimeExecuted = async () =>
            (await executed()).some((p) => runtimePreload.includes(p));

        // The deferred-only variant: interaction + below-the-fold visible
        // islands only — nothing can fire at load.
        await page.goto(`http://localhost:${PORT}/?deferred`, { waitUntil: 'load', timeout: 20000 });

        // The document still WARMS the runtime (preload ≠ execute).
        for (const chunk of runtimePreload) {
            assert(
                await page.locator(`link[rel="modulepreload"][href="${chunk}"]`).count() === 1,
                `document modulepreloads ${chunk}`
            );
        }

        // Settle well past any idle callback — then the whole point:
        await page.waitForTimeout(1200);
        assert(!(await runtimeExecuted()),
            'sigx runtime chunk NOT executed at load (deferred-only page)');

        // First interaction: a real click wakes the client:interaction Echo
        // island (pointerdown reaches the capture listener on its anchor).
        const echoInput = page.locator('.card input').first();
        await echoInput.click();
        // Type into Echo and see it mirror UPPERCASE — the island is LIVE.
        await echoInput.pressSequentially('resumed!');
        await page.waitForFunction(() =>
            document.body.textContent.includes('RESUMED!'), undefined, { timeout: 10000 });
        assert(true, 'client:interaction island hydrated and is live after first interaction');
        assert(await runtimeExecuted(),
            'sigx runtime chunk EXECUTED after the first strategy fired');

        // Full page sanity: the default variant still hydrates client:load.
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 20000 });
        const plus = page.locator('button', { hasText: '+1' }).first();
        await plus.click();
        await page.waitForFunction(() =>
            [...document.querySelectorAll('strong')].some((el) => el.textContent === '1'),
            undefined, { timeout: 10000 });
        assert(true, 'default page: client:load counter is interactive');
    } finally {
        await browser.close();
    }
    console.log('islands-smoke: ALL PASSED');
} finally {
    server.kill('SIGTERM');
}
process.exit(0);
