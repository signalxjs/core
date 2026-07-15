// Browser smoke for the resumability ladder (#241). Run after `pnpm build`
// (workspace) + `pnpm --filter @sigx/resume-example build`:
//
//   node smoke.mjs
//
// Asserts, with a real chromium against the production server, using JS
// coverage (EXECUTION, not fetches — the document engine modulepreloads
// boundary chunks as a warm-cache hint, which is bytes, not behavior):
//   1. On load, the ONLY script that executes is the loader entry.
//   2. First counter click: the handler chunk executes and the event
//      REPLAYS (7 → 8 in one click); the write upgrades → the component
//      chunk executes; post-upgrade clicks run the live listener.
//   3. Tracker (read-only handler): its component chunk NEVER executes.
//   4. Legacy (wake-on-interaction): first click hydrates without replay,
//      second click is live.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4173;

function assert(cond, message) {
    if (!cond) {
        console.error(`❌ resume-smoke: ${message}`);
        process.exit(1);
    }
    console.log(`✔ ${message}`);
}

const server = spawn(process.execPath, ['--conditions', 'production', 'server.mjs'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
    stdio: 'ignore'
});

try {
    await new Promise((r) => setTimeout(r, 1500));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    // Non-destructive coverage snapshots via CDP — Playwright's own
    // stop/start coverage cycle disturbs in-flight module loading.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
    const executed = async () => {
        const { result } = await cdp.send('Profiler.takePreciseCoverage');
        return result
            .map((e) => { try { return new URL(e.url).pathname; } catch { return ''; } })
            .filter(Boolean);
    };

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

    // 1) The only EXECUTED script on load is the loader entry (boundary
    // chunks may be modulepreloaded — warmed, never run).
    const onLoad = (await executed()).filter((p) => p.startsWith('/assets/'));
    assert(onLoad.length === 1 && /\/index-/.test(onLoad[0]),
        `only the loader entry executes on load (got: ${onLoad.join(', ') || 'none'})`);

    // 2) Counter: replay + upgrade-on-write.
    const counter = page.locator('button', { hasText: 'hits:' });
    assert(await counter.textContent() === 'hits: 7', 'SSR state rendered (hits: 7)');
    await counter.click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('hits: 8')));
    assert(true, 'first click replayed through the QRL (7 → 8, no lost interaction)');
    const afterClick = await executed();
    assert(afterClick.some((p) => p.includes('.handlers-')),
        'handler chunk executed on first interaction');
    assert(afterClick.some((p) => /\/Counter-/.test(p)),
        'component chunk executed only after the state write (upgrade-on-write)');
    await counter.click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('hits: 9')));
    assert(true, 'post-upgrade clicks run the live hydrated listener (8 → 9)');

    // 3) Tracker: read-only handler → its component chunk never executes.
    await page.locator('button', { hasText: 'Log campaign' }).click();
    await page.waitForTimeout(300);
    const afterTracker = await executed();
    assert(afterTracker.some((p) => /Tracker\.tsx\.handlers-/.test(p)),
        'tracker handler chunk executed');
    assert(!afterTracker.some((p) => /\/Tracker-/.test(p)),
        'read-only handler never executes its component chunk');

    // 4) Legacy: wake-on-interaction, no replay.
    const legacy = page.locator('button', { hasText: 'Legacy stepper' });
    await legacy.click(); // wakes (hydrates); this click is NOT replayed
    await page.waitForTimeout(300);
    const afterWake = await executed();
    assert(afterWake.some((p) => /\/Legacy-/.test(p)), 'wake executed the Legacy component chunk');
    assert((await legacy.textContent()).includes('total 0'), 'wake does not replay the triggering event');
    await legacy.click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('total 1')));
    assert(true, 'the woken component handles subsequent events live (total 1)');

    await browser.close();
    console.log('✅ resume-smoke: the full resumability ladder verified in a real browser');
} finally {
    server.kill();
}
