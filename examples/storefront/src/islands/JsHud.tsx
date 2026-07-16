import { component } from 'sigx';

/**
 * The page demonstrates its own claim: this HUD (a `client:idle` island)
 * watches the resource timeline and lists every script chunk the page has
 * fetched. On load you see the entry + islands runtime and NOTHING for the
 * ~48 product cards; click one card and watch exactly two chunks arrive
 * (the shared handlers chunk, then that card's component on the write).
 */
export const JsHud = component((ctx) => {
    const chunks = ctx.signal<{ list: string[] }>({ list: [] });

    ctx.onMounted(() => {
        const seen = new Set<string>();
        const push = (entry: PerformanceEntry) => {
            const url = entry.name;
            if (!url.includes('/assets/') || !url.includes('.js') || seen.has(url)) return;
            seen.add(url);
            chunks.$set({ list: [...chunks.list, url.slice(url.lastIndexOf('/') + 1)] });
        };
        performance.getEntriesByType('resource').forEach(push);
        const observer = new PerformanceObserver((entries) => entries.getEntries().forEach(push));
        observer.observe({ type: 'resource', buffered: true });
        ctx.onUnmounted(() => observer.disconnect());
    });

    return () => (
        <details class="hud" open>
            <summary>JS chunks fetched: {chunks.list.length}</summary>
            <ol>
                {chunks.list.map((name) => <li key={name}>{name}</li>)}
            </ol>
        </details>
    );
});
