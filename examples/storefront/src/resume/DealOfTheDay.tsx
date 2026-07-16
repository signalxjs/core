import { component } from 'sigx';

// A module-scope pricing table the HANDLER captures — extracting it would
// chain the handler chunk to this whole module, so the transform declines at
// BUILD time (watch the vite output: `onclick of <DealOfTheDay> is not
// resumable — handler captures "TIERS" (module-scope binding)`) and the card
// falls back to wake-on-interaction: the first click fully hydrates it (not
// replayed), subsequent clicks are live. The JS HUD shows the difference —
// this card loads its component chunk on FIRST interaction, while
// ProductCards load a tiny shared handler chunk first and their component
// only after a state write.
const TIERS = [50, 40, 30, 25];

export const DealOfTheDay = component((ctx) => {
    const claims = ctx.signal(0);
    // Wake feedback (#269): the fallback's first click hydrates WITHOUT
    // replay — invisible by itself, which reads as broken. onMounted only
    // runs when the component actually wakes (never during SSR), so this
    // signal makes the wake visible: the button arms itself.
    const armed = ctx.signal(false);
    ctx.onMounted(() => { armed.value = true; });
    return () => (
        <aside class="deal">
            <h3>⚡ Deal of the day</h3>
            <p>Telescope bundle — {TIERS[Math.min(claims.value, TIERS.length - 1)]}% off</p>
            <button
                onClick={() => {
                    const discount = TIERS[Math.min(claims.value, TIERS.length - 1)];
                    window.dispatchEvent(new CustomEvent('cart:add', {
                        detail: { id: 'deal-telescope', price: Math.round(320 * (100 - discount) / 100) }
                    }));
                    claims.value++;
                }}
            >
                {claims.value > 0
                    ? `Claimed ×${claims.value} (discount shrinks!)`
                    : armed.value ? '⚡ Armed — click to claim!' : 'Claim the deal'}
            </button>
            <p class="hint">
                {armed.value
                    ? 'woken by your first click (wake-on-interaction; not replayed by design)'
                    : 'wake-on-interaction fallback — first click wakes it, second click counts'}
            </p>
        </aside>
    );
});
