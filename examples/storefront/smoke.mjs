// Browser smoke for the storefront showcase (#265).
//
//   node smoke.mjs         # PROD: needs `pnpm build` (workspace) +
//                          # `pnpm --filter @sigx/storefront-example build`
//   node smoke.mjs --dev   # DEV: spawns the dev server directly — only the
//                          # workspace dists need to exist (`pnpm build`)
//
// Coverage-based (EXECUTION, not fetches): with ~48 resumable cards on the
// page, nothing card-related executes until a card is clicked — and the two
// islands are the only deliberate JS spend at load.
//
// `node smoke.mjs --dev` runs the behavioral half against the DEV server
// (unbundled modules — chunk-execution assertions don't apply, but state,
// props flow, replay, wake, and pd must all behave identically; #269).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT) || 4173;

function assert(cond, message) {
    if (!cond) {
        throw new Error(`❌ storefront-smoke: ${message}`);
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
    throw new Error(`❌ storefront-smoke: server did not come up on ${url}`);
}

const server = spawn(
    process.execPath,
    DEV ? ['server.mjs'] : ['--conditions', 'production', 'server.mjs'],
    {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        env: DEV
            ? { ...process.env, PORT: String(PORT) }
            : { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
        stdio: 'ignore'
    }
);

try {
    await waitForServer(`http://localhost:${PORT}/`, DEV ? 30000 : 15000);
    const browser = await chromium.launch();
    // A REAL-Chrome UA: HeadlessChrome matches server.mjs's isBot regex and
    // gets the blocking document — the human path is the STREAMING document,
    // and it must be what the smoke exercises (#279 hid there).
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

    // 'load' — a streaming document keeps the network busy past any
    // networkidle threshold; load fires when the stream closes.
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('.category:not(.skeleton)', { timeout: 10000 });
    await page.waitForTimeout(800); // islands settle (client:idle HUD)

    // 1) 48 cards + form + deal on the page, ZERO of their code executed —
    // the only JS spend is the entry and the two deliberate islands.
    assert(await page.locator('.card').count() === 48, '48 product cards rendered (streamed)');
    if (!DEV) {
        const onLoad = await executed();
        assert(!onLoad.some((p) => /ProductCard|Newsletter|DealOfTheDay|handlers-/.test(p)),
            `no card/form/deal code executed on load (executed: ${onLoad.length} chunks — entry + islands only)`);
    }
    assert(await page.locator('.badge').textContent() === '🛒 empty', 'cart badge island is live');

    // 2) First card click: replay + upgrade + cross-boundary event.
    const firstCard = page.locator('.card', { hasText: 'Monstera' });
    await firstCard.locator('button').click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.card button')].some((b) => b.textContent === 'In cart ×1'), undefined, { timeout: 10000 });
    assert(true, 'first click replayed: card shows In cart ×1');
    // '$34' — the props snapshot must flow through $scope.props into the
    // CustomEvent detail (the '$0 total' regression check, #269).
    await page.waitForFunction(() => document.querySelector('.badge')?.textContent?.includes('1 · $34'));
    assert(true, 'cart badge heard the CustomEvent with the PRICE from $scope.props');
    if (!DEV) {
        const afterFirst = await executed();
        assert(afterFirst.some((p) => /ProductCard\.tsx\.handlers-/.test(p)), 'shared handler chunk executed');
        assert(afterFirst.some((p) => /\/ProductCard-/.test(p)), 'card component chunk executed after the write');
    }

    // 3) Second card (warm cache): SINGLE increment — the #266 double-fire
    // regression — and no new chunk kinds in prod.
    const before = DEV ? 0 : (await executed()).length;
    await page.locator('.card', { hasText: 'Camera' }).locator('button').click();
    await page.waitForFunction(() => document.querySelector('.badge')?.textContent?.includes('2 · $283'));
    // A late double-fire (#266) would increment AGAIN after the match —
    // settle, then assert the exact final value.
    await page.waitForTimeout(600);
    assert((await page.locator('.badge').textContent()) === '🛒 2 · $283',
        'second card: exactly one increment on a warm cache, and it STAYS at 2 · $283');
    if (!DEV) assert((await executed()).length === before, 'second card reuses the loaded chunks');

    // 4) Newsletter: synchronous preventDefault + replay through the QRL.
    await page.fill('.newsletter input', 'demo@sigx.dev');
    await page.locator('.newsletter button').click();
    await page.waitForSelector('.thanks');
    assert(page.url().endsWith('/'), 'form submit prevented synchronously (no navigation)');
    assert(true, 'newsletter upgraded to the thanks state');

    // 5) Deal of the day: wake-on-interaction — first click hydrates (and
    // visibly ARMS, #269) without replaying.
    const deal = page.locator('.deal button');
    await deal.click();
    await page.waitForFunction(() =>
        document.querySelector('.deal button')?.textContent?.includes('Armed'), undefined, { timeout: 10000 });
    assert(true, 'wake armed the deal visibly without replaying the click');
    if (!DEV) assert((await executed()).some((p) => /\/DealOfTheDay-/.test(p)), 'deal component chunk executed on wake');
    await deal.click();
    await page.waitForFunction(() =>
        document.querySelector('.deal button')?.textContent?.includes('×1'));
    assert(true, 'woken deal handles the second click live');

    // 6) The HUD island documents the whole story.
    const hud = await page.locator('.hud summary').textContent();
    assert(DEV ? /dev modules fetched: \d+/.test(hud ?? '') : /JS chunks fetched: \d+/.test(hud ?? ''),
        `HUD reporting (${hud})`);

    await browser.close();
    console.log('✅ storefront-smoke: the showcase behaves as advertised');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    server.kill();
}
