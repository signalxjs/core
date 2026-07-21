import { component } from 'sigx';
import { Counter } from './resume/Counter';
import { Tracker } from './resume/Tracker';
import { Legacy } from './resume/Legacy';
import { Quote } from './resume/Quote';
import { Catalog } from './resume/Catalog';
import { Poll } from './resume/Poll';
import { Feedback } from './resume/Feedback';

/**
 * Server-only page. The client ships ONLY the generated delegation loader
 * (<1 kB) — no page code, no component code, no framework runtime. Each
 * interaction below demonstrates a different rung of the resumability
 * ladder.
 */
export const App = component<{ ssrRequest: string }>((ctx) => {
    const rendered = new Date().toISOString();
    return () => (
        <main>
            <h1>SignalX resumability</h1>
            <p class="hint">
                Server-rendered at {rendered}. Open the network panel: no
                component JS loads until you interact, and component chunks
                load only when state actually changes.
            </p>
            <p class="hint">
                {/* Produced by a server function called during SSR, reading
                    the live document request (rfc-server §7 v1.1). */}
                {ctx.props.ssrRequest}
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
                <h3>3 — server function from a resumed handler</h3>
                <p class="hint">
                    The handler imports from a *.server.ts module — the click
                    loads the handler chunk, POSTs to /_sigx/fn/&lt;symbol&gt;,
                    and the server does the work. The server module's code
                    never ships to the browser.
                </p>
                <Quote />
            </div>

            <div class="card">
                <h3>4 — cacheable GET read, rich types</h3>
                <p class="hint">
                    A cache-marked serverFn is called with GET — the response
                    carries Cache-Control, so the browser and any edge cache
                    absorb repeats — and Date/Set/BigInt arrive as live
                    instances, verified right here in the browser.
                </p>
                <Catalog />
            </div>

            <div class="card">
                <h3>5 — single-flight boundary refresh</h3>
                <p class="hint">
                    The vote mutation declares <code>refreshes</code> — its
                    response carries this boundary's freshly re-rendered HTML
                    and the client swaps it in. Fresh UI in ONE request, and
                    the component chunk never loads.
                </p>
                <Poll />
            </div>

            <div class="card">
                <h3>6 — zero-JS form action</h3>
                <p class="hint">
                    The build stamped a real action/method onto this form, so
                    submitting works with JS disabled (native POST, 303 back
                    here). With JS, the same server function runs over RPC.
                    View source: the form has both a QRL and an action.
                </p>
                <Feedback />
            </div>

            <div class="card">
                <h3>7 — wake-on-interaction fallback</h3>
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
