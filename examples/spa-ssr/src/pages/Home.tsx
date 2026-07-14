import { component, useData, useHead } from 'sigx';

import { useRouter, type Route } from '../router';

interface Stats {
    stars: number;
    downloads: number;
    renderedAt: string;
}

/** Fake database/API call — stands in for any per-request data source. */
async function fetchStats(): Promise<Stats> {
    console.log('[server] fetching stats…');
    await new Promise(r => setTimeout(r, 150));
    return { stars: 1842, downloads: 96512, renderedAt: new Date().toISOString() };
}

/**
 * The async boundary lives in its OWN component, scoped to the data it owns.
 * In streaming mode only THIS card gets a placeholder and is swapped when the
 * fetch resolves — everything else on the page streams as plain shell HTML,
 * exactly once. (Putting useData in the page component would wrap the whole
 * page in the boundary: the full content would ship twice and visibly swap.)
 */
const StatsCard = component(() => {
    // Keyed useData runs on the server; serialized into
    // window.__SIGX_ASYNC__ by renderDocument and restored during hydration
    // — the client does NOT refetch (watch the network tab / server log).
    const stats = useData('stats', fetchStats);

    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Server-loaded data (no client refetch)</h3>
            {stats.match({
                pending: () => <p>Loading stats…</p>,
                ready: (s) => <p><code>useData()</code> fetched on the server: ⭐ {s.stars} · ⬇ {s.downloads} · rendered {s.renderedAt}</p>,
            })}
            <p style="color: #555; font-size: 0.95em;">The values were serialized into <code>window.__SIGX_ASYNC__</code> and restored during hydration — the fetch did not run again in your browser.</p>
        </div>
    );
}, { name: 'StatsCard' });

export const Home = component((ctx) => {
    useHead({ title: 'Home' });
    const tipVisible = ctx.signal(false);
    const router = useRouter();

    function onLink(e: MouseEvent, path: Route): void {
        e.preventDefault();
        router.navigate(path);
    }

    return () => (
        <>
            <h1>Server-rendered SignalX</h1>
            <p>This page was rendered to HTML on the server, then hydrated on the client. View source — the markup is already there.</p>
            <StatsCard />
            <div class="card">
                <button onClick={() => (tipVisible.value = !tipVisible.value)}>
                    {tipVisible.value ? 'Hide' : 'Show'} the SSR tip
                </button>
                {/* use:show works on the server too: the directive's
                    getSSRProps ships hidden elements with display:none
                    inline, so there is no flash before hydration —
                    view source to see it. */}
                <p use:show={tipVisible.value}>
                    This paragraph was server-rendered with <code>display:none</code> and
                    toggles instantly after hydration — it never re-mounts.
                </p>
            </div>
            <div class="card">
                <p>Each route is rendered server-side. Try loading any of them directly:</p>
                <ul>
                    <li><a href="/" onClick={(e) => onLink(e as MouseEvent, '/')}>/</a> — this page</li>
                    <li><a href="/counter" onClick={(e) => onLink(e as MouseEvent, '/counter')}>/counter</a> — proves hydration is real (the button works)</li>
                    <li><a href="/forms" onClick={(e) => onLink(e as MouseEvent, '/forms')}>/forms</a> — model bindings, props/events, custom Define.Model</li>
                    <li><a href="/about" onClick={(e) => onLink(e as MouseEvent, '/about')}>/about</a> — what this example demonstrates</li>
                </ul>
                <p style="color: #555; font-size: 0.95em;">Reload any page or <code>curl</code> it — the response contains the rendered markup directly.</p>
            </div>
        </>
    );
});
