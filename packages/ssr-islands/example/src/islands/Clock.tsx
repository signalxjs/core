import { component } from 'sigx';

/**
 * Hydration made visible: the server renders one frozen timestamp; the
 * moment this island hydrates (client:idle — when the browser has nothing
 * better to do), the clock starts ticking.
 */
export const Clock = component((ctx) => {
    const state = ctx.signal({ now: new Date().toLocaleTimeString() });
    // Only the browser ticks; the server renders the one-shot initial value.
    // (No teardown needed — this island lives as long as the page.)
    if (typeof window !== 'undefined') {
        setInterval(() => {
            state.now = new Date().toLocaleTimeString();
        }, 1000);
    }
    return () => (
        <p>
            server said <strong>{state.now}</strong> — when this ticks, the island has hydrated
        </p>
    );
}, { name: 'Clock' });
