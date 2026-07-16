import { component } from 'sigx';

/**
 * The page demonstrates its own claim: this HUD (a `client:idle` island)
 * watches the resource timeline and lists every script chunk the page has
 * fetched. On load you see the entry, the tiny boundary scheduler, and the
 * (preloaded) hydration runtime that the client:load cart badge wakes —
 * and NOTHING for the ~48 product cards; click one card and watch exactly
 * two chunks arrive (the shared handlers chunk, then that card's component
 * on the write). On a page with no client:load island the runtime would
 * not even execute until the first strategy fired (#293).
 */
export const JsHud = component((ctx) => {
    const chunks = ctx.signal<{ list: { key: string; label: string }[] }>({ list: [] });

    ctx.onMounted(() => {
        const seen = new Set<string>();
        // Dev serves UNBUNDLED modules (no /assets/ chunks) — count what the
        // mode actually loads, and label it, or the HUD lies in dev (#269).
        const isChunk = (url: string) => import.meta.env.DEV
            // Vite internals (/@vite/client etc.) have no extension — count
            // every /@-prefixed dev module too, or the HUD undercounts.
            ? /\.m?[jt]sx?(\?|$)/.test(url) || new URL(url, location.href).pathname.startsWith('/@')
            : url.includes('/assets/') && url.includes('.js');
        const push = (entry: PerformanceEntry) => {
            const url = entry.name;
            if (!isChunk(url) || seen.has(url)) return;
            seen.add(url);
            const label = (url.includes('/@id/') ? url.slice(url.indexOf('/@id/') + 5)
                : url.slice(url.lastIndexOf('/') + 1)).split('?')[0];
            // Key by the full URL — dev labels collide (every dist entry is
            // an index.js) and duplicate keys break list reconciliation.
            chunks.$set({ list: [...chunks.list, { key: url, label }] });
        };
        performance.getEntriesByType('resource').forEach(push);
        const observer = new PerformanceObserver((entries) => entries.getEntries().forEach(push));
        observer.observe({ type: 'resource', buffered: true });
        ctx.onUnmounted(() => observer.disconnect());
    });

    return () => (
        <details class="hud" open>
            <summary>
                {import.meta.env.DEV
                    ? `dev modules fetched: ${chunks.list.length} (unbundled — judge payload in prod)`
                    : `JS chunks fetched: ${chunks.list.length}`}
            </summary>
            <ol>
                {chunks.list.map((entry) => <li key={entry.key}>{entry.label}</li>)}
            </ol>
        </details>
    );
});
