import { component, useData, useHead } from 'sigx';
import type { CachedAsyncState } from '@sigx/cache';

/** Fake API with a per-key hit counter so dedupe is visible in the UI. */
const hits: Record<string, number> = {};
async function fetchQuote(key: string): Promise<{ text: string; fetchNo: number }> {
    hits[key] = (hits[key] ?? 0) + 1;
    await new Promise(r => setTimeout(r, 120));
    return { text: 'Signals all the way down.', fetchNo: hits[key] };
}

/** Rejects on every second call — exercises the error arm + retry. */
let flakyCalls = 0;
async function fetchFlaky(): Promise<{ ok: string }> {
    await new Promise(r => setTimeout(r, 120));
    if (++flakyCalls % 2 === 1) throw new Error(`upstream 503 (call #${flakyCalls})`);
    return { ok: `recovered on call #${flakyCalls}` };
}

// ── Dedupe: two components, ONE key → one fetch per request/page ──────

const QuoteCard = component(() => {
    // The key is also the fetcher's first argument — one shape everywhere.
    const quote = useData('quote', (key) => fetchQuote(key));
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Dedupe A</h3>
            {quote.match({
                pending: () => <p>Loading…</p>,
                ready: (q) => <p>{`"${q.text}" — fetch #${q.fetchNo}`}</p>,
            })}
        </div>
    );
});

const QuoteBadge = component(() => {
    // Same key as QuoteCard — joins the SAME fetch, never issues a second one
    const quote = useData('quote', (key) => fetchQuote(key));
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Dedupe B (same key)</h3>
            {quote.match({
                pending: () => <p>Loading…</p>,
                ready: (q) => <p>{`fetch #${q.fetchNo} — same number as Dedupe A proves one fetch served both`}</p>,
            })}
        </div>
    );
});

// ── Error arm + retry: no error boundary needed ────────────────────────

const FlakyCard = component(() => {
    const flaky = useData('flaky', fetchFlaky);
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Soft errors + retry</h3>
            {flaky.match({
                pending: () => <p>Loading…</p>,
                error: (e, retry) => (
                    <p style="color: #b00;">
                        {e.message}{' '}
                        <button onClick={retry}>Retry</button>
                    </p>
                ),
                ready: (v) => (
                    <p>
                        ✅ {v.ok}{' '}
                        <button onClick={() => flaky.refresh()}>Refetch (will fail again)</button>
                    </p>
                ),
            })}
            <p style="color: #555; font-size: 0.95em;">The fetcher rejects every odd call. The error lands on the <code>error</code> arm with its own <code>retry</code> — this card owns its retry UI and the rest of the page is untouched.</p>
        </div>
    );
});

// ── { server: false }: keyed but client-only ───────────────────────────

const BrowserCard = component(() => {
    // server:false → never runs during SSR. The server ships the pending
    // arm; the browser fetches after hydration. Still keyed — identity for
    // dedupe and future cache coverage.
    const browser = useData('browser-info', async () => {
        await new Promise(r => setTimeout(r, 300));
        return {
            viewport: `${window.innerWidth}×${window.innerHeight}`,
            language: navigator.language
        };
    }, { server: false });
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">{'{ server: false } = client-only'}</h3>
            {browser.match({
                pending: () => <p>Measuring in your browser…</p>,
                ready: (b) => <p>Viewport {b.viewport} · language {b.language}</p>,
            })}
            <p style="color: #555; font-size: 0.95em;"><code>useData(key, fn, {'{ server: false }'})</code> never runs during SSR — view source: this card ships as the pending arm. Right for browser-dependent work.</p>
        </div>
    );
});


// ── @sigx/cache: staleTime + invalidate + optimistic mutate ────────────

// The counter only counts CLIENT refetches — a module-level "fetch #" would
// exist separately on the server and in the browser, so its numbers carry no
// meaning across the SSR/hydration boundary. The timestamp is the continuity
// proof; `src` says which side produced it.
let clientRefetches = 0;
async function fetchStamp(): Promise<{ stamp: string; src: string }> {
    await new Promise(r => setTimeout(r, 120));
    const src = typeof window === 'undefined' ? 'server-rendered' : `client refetch #${++clientRefetches}`;
    return { stamp: new Date().toLocaleTimeString(), src };
}

const CacheCard = component(() => {
    // staleTime 10s from the last fetch (the SSR value seeds the cache on
    // hydration): revisits inside the window serve from the cache, later
    // ones revalidate in the background.
    const stamp = useData('cache-stamp', fetchStamp, {
        cache: { staleTime: 10_000 },
    }) as CachedAsyncState<{ stamp: string; src: string }>;

    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">@sigx/cache: staleTime + invalidate + mutate</h3>
            {stamp.match({
                pending: () => <p>Loading…</p>,
                ready: (s) => (
                    <p>
                        fetched at {s.stamp} ({s.src}){' '}
                        <button onClick={() => stamp.invalidate()}>Invalidate (refetch)</button>{' '}
                        <button onClick={() => stamp.mutate(c => ({ ...(c ?? s), stamp: 'mutated locally' }))}>
                            Mutate (write-through)
                        </button>
                    </p>
                ),
            })}
            <p style="color: #555; font-size: 0.95em;">Leave and revisit this page within 10s of the last fetch — the card renders instantly from the cache with the same timestamp, no request. Past 10s, revisiting revalidates in the background and the timestamp updates. <code>invalidate()</code> drops the entry and refetches; <code>mutate()</code> writes through without a request.</p>
        </div>
    );
});

export const Data = component(() => {
    useHead({
        title: 'Data loading',
        meta: [{ name: 'description', content: 'useData patterns: dedupe, error arm + retry, refresh, client-only' }]
    });

    return () => (
        <>
            <h1>useData patterns</h1>
            <p>One primitive, four behaviors — reload the page (server-fetched + restored) and click the buttons (client refetch).</p>
            <QuoteCard />
            <QuoteBadge />
            <FlakyCard />
            <BrowserCard />
            <CacheCard />
        </>
    );
});
