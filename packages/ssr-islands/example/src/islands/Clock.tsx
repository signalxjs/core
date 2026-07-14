import { component, onMounted, onUnmounted } from 'sigx';

/**
 * Hydration made visible: the server renders one frozen timestamp; the
 * moment this island hydrates (client:idle — when the browser has nothing
 * better to do), the clock starts ticking.
 */
export const Clock = component((ctx) => {
    const state = ctx.signal({ now: new Date().toLocaleTimeString() });
    // Mount hooks never run during SSR, so only the browser ticks — and the
    // timer is cleared on unmount (dev/HMR remounts don't leak intervals).
    let timer: ReturnType<typeof setInterval>;
    onMounted(() => {
        timer = setInterval(() => {
            state.now = new Date().toLocaleTimeString();
        }, 1000);
    });
    onUnmounted(() => clearInterval(timer));
    return () => (
        <p>
            server said <strong>{state.now}</strong> — when this ticks, the island has hydrated
        </p>
    );
}, { name: 'Clock' });
