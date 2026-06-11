import { component, useAsync, useHead } from 'sigx';

/** Fake API with a per-key hit counter so dedupe is visible in the UI. */
const hits: Record<string, number> = {};
async function fetchQuote(key: string): Promise<{ text: string; fetchNo: number }> {
    hits[key] = (hits[key] ?? 0) + 1;
    await new Promise(r => setTimeout(r, 120));
    return { text: 'Signals all the way down.', fetchNo: hits[key] };
}

/** Rejects on every second call — exercises the error branch + retry. */
let flakyCalls = 0;
async function fetchFlaky(): Promise<{ ok: string }> {
    await new Promise(r => setTimeout(r, 120));
    if (++flakyCalls % 2 === 1) throw new Error(`upstream 503 (call #${flakyCalls})`);
    return { ok: `recovered on call #${flakyCalls}` };
}

// ── Dedupe: two components, ONE key → one fetch per request/page ──────

const QuoteCard = component(() => {
    const quote = useAsync('quote', () => fetchQuote('quote'));
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Dedupe A</h3>
            <p>{quote.value ? `"${quote.value.text}" — fetch #${quote.value.fetchNo}` : 'Loading…'}</p>
        </div>
    );
});

const QuoteBadge = component(() => {
    // Same key as QuoteCard — joins the SAME fetch, never issues a second one
    const quote = useAsync('quote', () => fetchQuote('quote'));
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Dedupe B (same key)</h3>
            <p>{quote.value
                ? `fetch #${quote.value.fetchNo} — same number as Dedupe A proves one fetch served both`
                : 'Loading…'}</p>
        </div>
    );
});

// ── Error branch + refresh(): no error boundary needed ────────────────

const FlakyCard = component(() => {
    const flaky = useAsync('flaky', fetchFlaky);
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Soft errors + refresh()</h3>
            {flaky.loading && <p>Loading…</p>}
            {flaky.error && (
                <p style="color: #b00;">
                    {flaky.error.message}{' '}
                    <button onClick={() => flaky.refresh()}>Retry</button>
                </p>
            )}
            {flaky.value && (
                <p>
                    ✅ {flaky.value.ok}{' '}
                    <button onClick={() => flaky.refresh()}>Refetch (will fail again)</button>
                </p>
            )}
            <p style="color: #555; font-size: 0.95em;">The fetcher rejects every odd call. Without <code>throwOnError</code> the error lands on <code>.error</code> and this card owns its retry UI — the rest of the page is untouched.</p>
        </div>
    );
});

// ── Unkeyed useAsync: client-only by definition ────────────────────────

const BrowserCard = component(() => {
    // No key → never runs on the server. SSR ships the loading branch;
    // the browser fills it in after hydration.
    const browser = useAsync(async () => {
        await new Promise(r => setTimeout(r, 300));
        return {
            viewport: `${window.innerWidth}×${window.innerHeight}`,
            language: navigator.language
        };
    });
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Unkeyed = client-only</h3>
            {browser.value
                ? <p>Viewport {browser.value.viewport} · language {browser.value.language}</p>
                : <p>Measuring in your browser…</p>}
            <p style="color: #555; font-size: 0.95em;"><code>useAsync(fn)</code> without a key never runs during SSR — view source: this card ships as the loading branch. Right for browser-dependent work.</p>
        </div>
    );
});

export const Data = component(() => {
    useHead({
        title: 'Data loading',
        meta: [{ name: 'description', content: 'useAsync patterns: dedupe, soft errors, refresh, client-only' }]
    });

    return () => (
        <>
            <h1>useAsync patterns</h1>
            <p>One primitive, four behaviors — reload the page (server-fetched + restored) and click the buttons (client refetch).</p>
            <QuoteCard />
            <QuoteBadge />
            <FlakyCard />
            <BrowserCard />
        </>
    );
});
