import { component } from 'sigx';

export const About = component(() => {
    return () => (
        <>
            <h1>About</h1>
            <p>The smallest credible SSR shape for SignalX: an Express server, <code>renderToString</code> on the way out, <code>ssrClientPlugin</code> + <code>hydrate()</code> on the way in.</p>
            <div class="card">
                <h3 style="margin-top: 0;">How it works</h3>
                <ul>
                    <li><code>server.ts</code> — Express. Dev mode pipes through Vite SSR middleware; prod mode serves prebuilt assets.</li>
                    <li><code>src/entry-server.tsx</code> — exports <code>render(url)</code>: builds a fresh <code>defineApp(&lt;App /&gt;)</code> per request, provides a per-request router, then <code>renderToString(app)</code>.</li>
                    <li><code>src/entry-client.tsx</code> — same shape on the client: one <code>defineApp</code>, provides a router built from <code>location.pathname</code>, then <code>.hydrate('#app')</code>.</li>
                    <li><code>src/router.ts</code> — exports a <code>useRouter</code> injectable token (via <code>defineInjectable</code>). Components call <code>useRouter()</code> to get the per-app instance — never a module global.</li>
                </ul>
            </div>
            <div class="card">
                <h3 style="margin-top: 0;">Concurrent-SSR safety</h3>
                <p>The router is scoped to the app instance through SignalX's DI. Each SSR request creates its own <code>defineApp</code> and provides its own <code>createRouter(parseUrl(url))</code>. Two requests for different URLs can't interleave — they each see their own signal.</p>
                <p>The official <code>@sigx/router</code> package (separate repo) uses the same pattern with more bells and whistles (named routes, guards, scroll restoration). For a tiny demo, ~30 lines of <code>router.ts</code> is enough.</p>
            </div>
        </>
    );
});
