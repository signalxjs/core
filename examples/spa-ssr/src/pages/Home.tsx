import { component } from 'sigx';
import { useHead } from '@sigx/server-renderer/client';
import { useRouter, type Route } from '../router';

interface Stats {
    stars: number;
    downloads: number;
    renderedAt: string;
}

/** Fake database/API call — stands in for any per-request data source. */
async function fetchStats(): Promise<Stats> {
    await new Promise(r => setTimeout(r, 150));
    return { stars: 1842, downloads: 96512, renderedAt: new Date().toISOString() };
}

export const Home = component((ctx) => {
    useHead({ title: 'Home' });
    const router = useRouter();

    // Runs on the server; serialized into window.__SIGX_STATE__ by
    // renderDocument and restored during hydration — the client does NOT
    // refetch (watch the network tab / server log).
    const stats = (ctx.signal as any)(null, 'stats') as { value: Stats | null };
    ctx.ssr.load(async () => {
        console.log('[server] fetching stats…');
        stats.value = await fetchStats();
    });

    function onLink(e: MouseEvent, path: Route): void {
        e.preventDefault();
        router.navigate(path);
    }

    return () => (
        <>
            <h1>Server-rendered SignalX</h1>
            <p>This page was rendered to HTML on the server, then hydrated on the client. View source — the markup is already there.</p>
            <div class="card">
                <h3 style="margin-top: 0;">Server-loaded data (no client refetch)</h3>
                {stats.value
                    ? <p><code>ssr.load()</code> fetched on the server: ⭐ {stats.value.stars} · ⬇ {stats.value.downloads} · rendered {stats.value.renderedAt}</p>
                    : <p>Loading stats…</p>}
                <p style="color: #555; font-size: 0.95em;">The values were serialized into <code>window.__SIGX_STATE__</code> and restored during hydration — the fetch did not run again in your browser.</p>
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
