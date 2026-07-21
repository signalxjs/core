// Hydration smoke (#377): does a PRODUCTION build actually hydrate in place,
// or did it silently fall back to a full client re-render?
//
// Run after `pnpm build`:  pnpm smoke:hydration
//
// Hydration has no observable success signal in a prod dist: both mismatch
// warnings are `__DEV__`-gated, so they are stripped from every prod build.
// A page that bailed still WORKS — it just threw away everything SSR was
// for — so the failure is invisible to CI, to a smoke test, and to a user.
// #367 cost a day of repro harnesses for exactly this reason: there was no
// way to simply ask whether a page hydrated.
//
// THE ORACLE. SSR emits a trailing `<!--$c:N-->` marker per component. The
// structural-mismatch bail calls `removeSSRRange`, which deletes a whole DOM
// range INCLUDING the nested markers inside it. So:
//
//   every marker in the served HTML is still in the live DOM
//     ⟹ no server-rendered range was discarded
//
// Direction matters. This is a SUBSET check, not an equality check: markers
// may legitimately be ADDED after first paint, because a streamed boundary's
// `$SIGX_REPLACE` splices in server-rendered content that the served document
// only carried as a placeholder (measured on spa-ssr `/about`: 3 served, 5
// live — both correct). Markers may never go MISSING.
//
// The one legitimate way to lose a marker is a streaming placeholder: its
// fallback content is replaced wholesale when the real content streams in, so
// markers inside `[data-async-placeholder]` are excluded from the required
// set — and the placeholders are then asserted to have actually resolved.
//
// `#app._vnode` is the second half: it proves the HYDRATOR ran, as opposed to
// a plain client mount that produces a working-but-not-hydrated page. It is
// only meaningful for the root-walk strategy — islands and resume deliberately
// never walk the root, so those apps prove liveness by interaction instead.
//
// WHAT THIS CATCHES, verified by injection (diverge a component's root tag
// between server and client with `typeof document !== 'undefined'`, rebuild,
// re-run):
//
//   - A bail that discards a range CONTAINING a component. Making the
//     fragment-rooted `Home` element-rooted and diverging its tag produced
//     `spa-ssr /: 3 required, 2 live, MISSING $c:3` — the nested StatsCard
//     marker went down with the discarded range. That is the whole-subtree /
//     whole-page class this gate exists for.
//
//   - NOT a bail whose discarded range contains no nested component. Doing
//     the same to `Counter`, a leaf, discarded and re-mounted its DOM with
//     every assertion still green: the range held no marker to lose. The
//     oracle observes components, not nodes. Leaf-level orphaning is the
//     unit suites' job (`hydrate-mismatch-cleanup`), not this gate's.
import { execSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');

// A real-Chrome UA: the examples' `isBot` regex matches /headless/, and a bot
// gets the blocking document — a different code path with nothing to hydrate.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

let failures = 0;

function assert(cond, message) {
    if (cond) {
        console.log(`  ✔ ${message}`);
    } else {
        failures++;
        console.error(`  ❌ ${message}`);
    }
}

/**
 * Collect the marker evidence for the current page: the ids SSR served
 * (re-fetched and parsed WITHOUT executing it) versus the ids live in the
 * DOM after hydration.
 */
const COLLECT = `(async () => {
    const markerIds = (doc, root) => {
        const ids = [];
        const it = doc.createNodeIterator(root, NodeFilter.SHOW_COMMENT);
        for (let n; (n = it.nextNode());) {
            if (n.data.startsWith('$c:')) ids.push(n.data);
        }
        return ids;
    };

    const app = document.getElementById('app');
    if (!app) return { error: 'no #app in the live document' };

    // DOMParser gives an apples-to-apples comparison: it builds real comment
    // nodes and does NOT execute the streamed $SIGX_REPLACE scripts, so this
    // is the document as SSR sent it. (A regex over the raw text would also
    // count markers that appear escaped inside those script payloads.)
    const doc = new DOMParser().parseFromString(
        await (await fetch(location.href)).text(), 'text/html'
    );
    const servedApp = doc.getElementById('app');
    if (!servedApp) return { error: 'no #app in the served document' };

    // Markers inside a streaming placeholder belong to the FALLBACK, which is
    // replaced wholesale when the real content arrives — not evidence of a bail.
    const inPlaceholder = new Set();
    for (const ph of servedApp.querySelectorAll('[data-async-placeholder]')) {
        for (const id of markerIds(doc, ph)) inPlaceholder.add(id);
    }
    const served = markerIds(doc, servedApp);

    return {
        served,
        required: served.filter((id) => !inPlaceholder.has(id)),
        live: markerIds(document, app),
        servedPlaceholders: servedApp.querySelectorAll('[data-async-placeholder]').length,
        livePlaceholders: app.querySelectorAll('[data-async-placeholder]').length,
        hydratorRan: !!app._vnode
    };
})()`;

/** Multiset difference: ids required by the served document that the live DOM lost. */
function missingMarkers(required, live) {
    const pool = [...live];
    const missing = [];
    for (const id of required) {
        const at = pool.indexOf(id);
        if (at === -1) missing.push(id);
        else pool.splice(at, 1);
    }
    return missing;
}

async function assertMarkerSurvival(page, label) {
    const ev = await page.evaluate(COLLECT);
    if (ev.error) {
        failures++;
        console.error(`  ❌ ${label}: ${ev.error}`);
        return ev;
    }

    const missing = missingMarkers(ev.required, ev.live);
    const excluded = ev.served.length - ev.required.length;
    assert(
        missing.length === 0,
        `${label}: every server-rendered range survived hydration `
        + `(${ev.required.length} required, ${ev.live.length} live`
        + `${excluded ? `, ${excluded} excluded as streaming fallback` : ''}`
        + `${missing.length ? `, MISSING ${missing.join(' ')}` : ''})`
    );
    return ev;
}

async function waitForServer(url, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(url, { headers: { 'user-agent': UA } });
            return;
        } catch {
            if (Date.now() > deadline) throw new Error(`server did not start within ${timeoutMs}ms`);
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}

/** Build an example, serve its production output, and drive it in Chrome. */
async function withApp({ filter, dir, port }, drive) {
    console.log(`\n[hydration-smoke] building ${filter}…`);
    execSync(`pnpm --filter ${filter} build`, { cwd: repoRoot, stdio: 'inherit' });

    const server = spawn(
        process.execPath,
        ['--conditions', 'production', 'server.mjs'],
        {
            cwd: join(repoRoot, dir),
            env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
            // Inherit stdout: a piped-but-undrained stream deadlocks the child.
            stdio: ['ignore', 'inherit', 'inherit']
        }
    );

    const origin = `http://localhost:${port}`;
    try {
        await waitForServer(`${origin}/`);
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ userAgent: UA });
            page.on('pageerror', (e) => {
                failures++;
                console.error(`  ❌ uncaught page error: ${e.message}`);
            });
            await drive(page, origin);
        } finally {
            await browser.close();
        }
    } finally {
        server.kill('SIGTERM');
    }
}

// ---- The root-walk strategy: spa-ssr ----------------------------------
// Plain hydration, no strategy pack. `/` is a static route; `/about` streams
// a deferred boundary, which is where the subset direction earns its keep.
await withApp({ filter: '@sigx/spa-ssr-example', dir: 'examples/spa-ssr', port: 4491 },
    async (page, origin) => {
        console.log('\n[hydration-smoke] spa-ssr (root walk)');

        for (const route of ['/', '/about', '/counter']) {
            await page.goto(origin + route, { waitUntil: 'load', timeout: 20000 });
            // Let a streamed boundary land and its hydration settle.
            await page.waitForTimeout(500);

            const ev = await assertMarkerSurvival(page, `spa-ssr ${route}`);
            assert(ev.hydratorRan, `spa-ssr ${route}: the hydrator ran (#app._vnode set)`);
        }

        // Liveness, and the strongest statement of "in place": the node that
        // reacts is the SAME node the server sent, not a client-mounted
        // replacement that happens to look identical.
        await page.goto(origin + '/counter', { waitUntil: 'load', timeout: 20000 });
        const value = await page.locator('.card strong').first().elementHandle();
        assert(
            (await value.textContent()).trim() === '0',
            'spa-ssr /counter: the server rendered count: 0'
        );
        await page.locator('button', { hasText: 'Increment' }).first().click();
        const inPlace = await page
            .waitForFunction((el) => el.textContent.trim() === '1', value, { timeout: 10000 })
            .then(() => true, () => false);
        assert(inPlace, 'spa-ssr /counter: the server-rendered node updated IN PLACE (same DOM node)');
        await assertMarkerSurvival(page, 'spa-ssr /counter after interaction');
    });

// ---- The boundary/scheduler path: islands ------------------------------
// Markers are consumed differently here — the boundary table keys off marker
// ids, and hydration happens per strategy, long after load. `?deferred` is
// the variant where nothing can fire until an interaction, so it separates
// "survived load" from "survived deferred hydration".
await withApp({ filter: '@sigx/ssr-islands-example', dir: 'examples/ssr-islands', port: 4492 },
    async (page, origin) => {
        console.log('\n[hydration-smoke] ssr-islands (boundary scheduling)');

        for (const route of ['/', '/?deferred']) {
            await page.goto(origin + route, { waitUntil: 'load', timeout: 20000 });
            await page.waitForTimeout(500);
            await assertMarkerSurvival(page, `islands ${route}`);
        }

        // Deferred hydration is the half that matters here: an island that
        // hydrates long after load — through the boundary table, keyed on
        // marker ids — must not discard its server-rendered DOM either.
        //
        // The page is on ?deferred, where nothing has hydrated yet. Retry the
        // input rather than typing once: the event that WAKES a
        // client:interaction island is deliberately not replayed, and the
        // wake-up loads a chunk, so the first keystrokes can land before the
        // handler exists. Retrying converges the moment hydration completes —
        // no sleep long enough to be safe and short enough to be quick.
        const echo = page.locator('.card input').first();
        await echo.click();
        let live = false;
        for (let attempt = 0; attempt < 20 && !live; attempt++) {
            await echo.fill('');
            await echo.fill('resumed!');
            live = await page
                .waitForFunction(() => document.body.textContent.includes('RESUMED!'),
                    undefined, { timeout: 500 })
                .then(() => true, () => false);
        }
        assert(live, 'islands ?deferred: the client:interaction island hydrated and is live');
        await assertMarkerSurvival(page, 'islands ?deferred after deferred hydration');

        // And the default variant, where client:load/idle islands hydrate at
        // load: the counter must increment through the server-rendered node.
        await page.goto(origin + '/', { waitUntil: 'load', timeout: 20000 });
        const plus = page.locator('button', { hasText: '+1' }).first();
        await plus.click();
        const counted = await page
            .waitForFunction(
                () => [...document.querySelectorAll('strong')].some((el) => el.textContent === '1'),
                undefined,
                { timeout: 10000 }
            )
            .then(() => true, () => false);
        assert(counted, 'islands /: the client:load island is interactive');
        await assertMarkerSurvival(page, 'islands / after interaction');
    });

if (failures > 0) {
    console.error(`\n❌ hydration-smoke: ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\n✅ hydration-smoke: every server-rendered range survived hydration');
process.exit(0);
