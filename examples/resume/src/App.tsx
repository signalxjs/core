import { component } from 'sigx';
import { Counter } from './resume/Counter';
import { Tracker } from './resume/Tracker';
import { Legacy } from './resume/Legacy';

/**
 * Server-only page. The client ships ONLY the generated delegation loader
 * (<1 kB) — no page code, no component code, no framework runtime. Each
 * interaction below demonstrates a different rung of the resumability
 * ladder.
 */
export const App = component(() => {
    const rendered = new Date().toISOString();
    return () => (
        <main>
            <h1>SignalX resumability</h1>
            <p class="hint">
                Server-rendered at {rendered}. Open the network panel: no
                component JS loads until you interact, and component chunks
                load only when state actually changes.
            </p>

            <div class="card">
                <h3>1 — QRL handler + upgrade-on-write</h3>
                <p class="hint">
                    First click: handler chunk loads, the event replays, the
                    write upgrades this one boundary (component chunk loads,
                    hydrates with the server state, replays the write).
                </p>
                <Counter label="hits" initial={7} />
            </div>

            <div class="card">
                <h3>2 — read-only handler</h3>
                <p class="hint">
                    Same handler chunk, but it only reads — the component
                    chunk never loads.
                </p>
                <Tracker campaign="launch" />
            </div>

            <div class="card">
                <h3>3 — wake-on-interaction fallback</h3>
                <p class="hint">
                    This component's handler captures a module-scope table, so
                    it is not extractable — the transform warned at build time
                    and the first click fully hydrates it instead (no replay).
                </p>
                <Legacy />
            </div>
        </main>
    );
});
