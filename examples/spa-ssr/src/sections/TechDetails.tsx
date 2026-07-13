import { component } from 'sigx';

/**
 * A code-split section, loaded via lazy() inside a <Defer> boundary on the
 * About page. The server awaits the chunk and streams the real content
 * (fallback first in streaming mode); the client preloads the chunk before
 * hydration so the server-resolved markup hydrates cleanly.
 */
export default component(() => {
    return () => (
        <div class="card">
            <h3 style="margin-top: 0;">Lazy-loaded section (Defer)</h3>
            <p>This block lives in a separate chunk — <code>lazy(() =&gt; import('./sections/TechDetails'))</code> wrapped in <code>&lt;Defer&gt;</code>.</p>
            <ul>
                <li><strong>Streaming SSR</strong>: the fallback flushes with the shell, then this content replaces it mid-stream.</li>
                <li><strong>Blocking SSR</strong> (bots): the server awaits the chunk and inlines this content directly.</li>
                <li><strong>Hydration</strong>: <code>entry-client.tsx</code> preloads the chunk before hydrating so the DOM matches.</li>
            </ul>
        </div>
    );
});
