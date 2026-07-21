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
//   4. Poll (single-flight boundary refresh, rfc-server §6.3): the vote
//      mutation's response carries fresh boundary HTML — the DOM updates
//      with NO component chunk, and the swapped boundary stays resumable.
//   5. Legacy (wake-on-interaction): first click hydrates without replay,
//      second click is live.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 4173;

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

async function waitForServer(url, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`❌ resume-smoke: server did not come up on ${url}`);
}

try {
    await waitForServer(`http://localhost:${PORT}/`);
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

    // 4) Poll: single-flight boundary refresh — one POST returns the
    // mutation result AND this boundary's fresh HTML; zero component chunks.
    const poll = page.locator('button', { hasText: 'Vote — total' });
    assert((await poll.textContent()).includes('total 3'), 'SSR vote total rendered (total 3)');
    await poll.click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('total 4')));
    assert(true, 'the mutation response refreshed the boundary in ONE request (3 → 4)');
    const afterVote = await executed();
    assert(afterVote.some((p) => /Poll\.tsx\.handlers-/.test(p)),
        'poll handler chunk executed');
    assert(!afterVote.some((p) => /\/Poll-/.test(p)),
        'refresh patched fresh server HTML without the Poll component chunk');
    // The swapped DOM re-wires delegation by attributes alone — vote again.
    await page.locator('button', { hasText: 'Vote — total' }).click();
    await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('total 5')));
    assert(true, 'the swapped boundary stays resumable — a second vote refreshes again (4 → 5)');
    assert(!(await executed()).some((p) => /\/Poll-/.test(p)),
        'still no Poll component chunk after the second refresh');

    // 5) Legacy: wake-on-interaction, no replay.
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
