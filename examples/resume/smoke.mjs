// Browser smoke for the resumability ladder (#241, #702). Run after
// `pnpm build` (workspace):
//
//   node smoke.mjs         # PROD: also needs `pnpm --filter @sigx/resume-example build`
//   node smoke.mjs --dev   # DEV: spawns the dev server — the same ladder,
//                          # unbundled (#702 phase 7)
//
// Asserts, with a real chromium, using JS coverage (EXECUTION, not fetches —
// the document engine modulepreloads boundary chunks as a warm-cache hint,
// which is bytes, not behavior):
//   1. On load, nothing but the loader entry executes (prod: the only
//      /assets/ script; dev: no resume module and no handlers module).
//   2. First counter click: the handler chunk executes and the event
//      REPLAYS (7 → 8 in one click); the write upgrades → the component
//      chunk executes; post-upgrade clicks run the live listener — and
//      exactly once (the #266 double-fire regression).
//   3. Tracker (read-only handler): its component chunk NEVER executes.
//   4. Poll (single-flight boundary refresh, rfc-server §6.3): the vote
//      mutation's response carries fresh boundary HTML — the DOM updates
//      with NO component chunk, and the swapped boundary stays resumable.
//   5. Legacy (wake-on-interaction): first click hydrates without replay,
//      second click is live.
//   6. (dev) The `[sigx resume]` console trace narrates replay, upgrade
//      and wake.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT) || 4173;
const MODE = DEV ? 'dev' : 'prod';

function assert(cond, message) {
    if (!cond) throw new Error(`❌ resume-smoke (${MODE}): ${message}`);
    console.log(`✔ ${message}`);
}

async function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`❌ resume-smoke (${MODE}): server did not come up on ${url}`);
}

// What an executed script path means in each mode. Prod: hashed chunks under
// /assets/. Dev: the component module is served at its source path and the
// handlers module as the `virtual:sigx-resume:<file>.handlers.ts` id.
const match = DEV
    ? {
          onlyLoader: (paths) => !paths.some((p) => /\/src\/resume\//.test(p) || /\.handlers\.ts$/.test(p)),
          handlers: (name) => (p) => new RegExp(`sigx-resume:src/resume/${name}\\.tsx\\.handlers\\.ts$`).test(decodeURIComponent(p)),
          component: (name) => (p) => new RegExp(`/src/resume/${name}\\.tsx$`).test(p)
      }
    : {
          onlyLoader: (paths) => {
              const assets = paths.filter((p) => p.startsWith('/assets/'));
              return assets.length === 1 && /\/index-/.test(assets[0]);
          },
          handlers: (name) => (p) => new RegExp(`${name}\\.tsx\\.handlers-`).test(p),
          component: (name) => (p) => new RegExp(`/${name}-`).test(p)
      };

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
    try {
        const page = await browser.newPage();
        page.on('pageerror', (e) => console.error('[pageerror]', e.message));
        const trace = [];
        page.on('console', (m) => { if (m.text().includes('[sigx resume]')) trace.push(m.text()); });
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
        const settledText = (locator, text) =>
            page.waitForFunction(
                (t) => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes(t)),
                text
            );

        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

        // 1) Nothing but the loader entry executes on load (boundary chunks
        // may be modulepreloaded in prod — warmed, never run).
        const onLoad = await executed();
        assert(match.onlyLoader(onLoad),
            `only the loader entry executes on load (${DEV ? 'no resume/handlers module ran' : onLoad.filter((p) => p.startsWith('/assets/')).join(', ') || 'none'})`);

        // 2) Counter: replay + upgrade-on-write, exactly once.
        const counter = page.locator('button', { hasText: 'hits:' });
        assert(await counter.textContent() === 'hits: 7', 'SSR state rendered (hits: 7)');
        await counter.click();
        await settledText(counter, 'hits: 8');
        assert(true, 'first click replayed through the QRL (7 → 8, no lost interaction)');
        const afterClick = await executed();
        assert(afterClick.some(match.handlers('Counter')), 'handler chunk executed on first interaction');
        assert(afterClick.some(match.component('Counter')),
            'component chunk executed only after the state write (upgrade-on-write)');
        await counter.click();
        await settledText(counter, 'hits: 9');
        // A late double-fire (#266: the upgrade attaching the real listener
        // while the same event still propagates) would increment AGAIN after
        // the match — settle, then assert the exact value.
        await page.waitForTimeout(600);
        assert((await counter.textContent()) === 'hits: 9',
            'post-upgrade click runs the live listener exactly once (8 → 9, and it STAYS at 9)');
        if (DEV) {
            assert(trace.some((l) => /boundary \d+ \(Counter\): replaying "Counter_click_/.test(l)), 'dev trace: the replay was logged');
            assert(trace.some((l) => /\(Counter\): first write to "hits" — upgrading/.test(l)), 'dev trace: the first write was logged');
            assert(trace.some((l) => /\(Counter\): upgraded — real listeners now own the element/.test(l)), 'dev trace: the upgrade was logged');
        }

        // 3) Tracker: read-only handler → its component chunk never executes.
        await page.locator('button', { hasText: 'Log campaign' }).click();
        await page.waitForTimeout(300);
        const afterTracker = await executed();
        assert(afterTracker.some(match.handlers('Tracker')), 'tracker handler chunk executed');
        assert(!afterTracker.some(match.component('Tracker')), 'read-only handler never executes its component chunk');

        // 4) Poll: single-flight boundary refresh — one POST returns the
        // mutation result AND this boundary's fresh HTML; zero component chunks.
        const poll = page.locator('button', { hasText: 'Vote — total' });
        assert((await poll.textContent()).includes('total 3'), 'SSR vote total rendered (total 3)');
        await poll.click();
        await settledText(poll, 'total 4');
        assert(true, 'the mutation response refreshed the boundary in ONE request (3 → 4)');
        const afterVote = await executed();
        assert(afterVote.some(match.handlers('Poll')), 'poll handler chunk executed');
        assert(!afterVote.some(match.component('Poll')), 'refresh patched fresh server HTML without the Poll component chunk');
        // The swapped DOM re-wires delegation by attributes alone — vote again.
        await page.locator('button', { hasText: 'Vote — total' }).click();
        await settledText(poll, 'total 5');
        assert(true, 'the swapped boundary stays resumable — a second vote refreshes again (4 → 5)');
        assert(!(await executed()).some(match.component('Poll')), 'still no Poll component chunk after the second refresh');

        // 5) Legacy: wake-on-interaction, no replay.
        const legacy = page.locator('button', { hasText: 'Legacy stepper' });
        await legacy.click(); // wakes (hydrates); this click is NOT replayed
        await page.waitForTimeout(300);
        assert((await executed()).some(match.component('Legacy')), 'wake executed the Legacy component chunk');
        assert((await legacy.textContent()).includes('total 0'), 'wake does not replay the triggering event');
        if (DEV) {
            assert(trace.some((l) => /\(Legacy\): woke \(hydrate mode\)/.test(l)), 'dev trace: the wake was logged');
        }
        await legacy.click();
        await settledText(legacy, 'total 1');
        assert(true, 'the woken component handles subsequent events live (total 1)');

        console.log(`✅ resume-smoke (${MODE}): the full resumability ladder verified in a real browser`);
    } finally {
        await browser.close();
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    server.kill();
}
