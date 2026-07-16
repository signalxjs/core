import { component } from 'sigx';

// A module-scope helper the handler captures — extracting the handler would
// chain its chunk to this whole module, so the transform declines
// (dev warning) and the component falls back to wake-on-interaction: the
// first click fully hydrates it (no replay), from then on it is live.
const STEPS = [1, 2, 5, 10];

export const Legacy = component((ctx) => {
    const idx = ctx.signal(0);
    const total = ctx.signal(0);
    return () => (
        <p>
            <button onClick={() => { total.value += STEPS[idx.value % STEPS.length]; idx.value++; }}>
                Legacy stepper (wake-on-interaction): total {total.value}
            </button>
        </p>
    );
});
