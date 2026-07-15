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
                {claims.value === 0 ? 'Claim the deal' : `Claimed ×${claims.value} (discount shrinks!)`}
            </button>
            <p class="hint">wake-on-interaction fallback — see the build warning</p>
        </aside>
    );
});
