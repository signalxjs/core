import { component } from 'sigx';
import { Counter } from './islands/Counter';
import { Clock } from './islands/Clock';
import { Echo } from './islands/Echo';
import { BrowserInfo } from './islands/BrowserInfo';
import { WideBadge } from './islands/WideBadge';

/**
 * The page itself is a server-only component: everything outside the
 * islands ships as static HTML and is never hydrated (in islands mode the
 * client skips the root walk entirely — only boundary-table entries mount).
 */
export const App = component(() => {
    return () => (
        <main>
            <h1>SignalX islands</h1>
            <p>
                This page is static HTML rendered by the server. Only the cards below carry
                JavaScript, each hydrating on its own schedule — declared per use with a{' '}
                <code>client:*</code> directive. Same <code>Counter</code> component, three
                different schedules.
            </p>

            <div class="card">
                <h3><code>client:load</code> — hydrate immediately</h3>
                <Counter client:load label="counts right away" />
            </div>

            <div class="card">
                <h3><code>client:idle</code> — hydrate when the browser is idle</h3>
                <Clock client:idle />
            </div>

            <div class="card">
                <h3><code>client:interaction</code> — hydrate on first pointer/key/touch/focus</h3>
                <Echo client:interaction />
            </div>

            <div class="card">
                <h3><code>client:media</code> — hydrate when a media query matches</h3>
                <WideBadge client:media="(min-width: 768px)" />
            </div>

            <div class="card">
                <h3><code>client:only</code> — skip SSR, mount fresh on the client</h3>
                <BrowserInfo client:only />
            </div>

            <div class="spacer">⬇ keep scrolling — the last island hydrates when it enters the viewport ⬇</div>

            <div class="card">
                <h3><code>client:visible</code> — hydrate when scrolled into view</h3>
                <Counter client:visible label="woke up when you scrolled here" initial={100} />
                <p class="hint">The chunk may arrive early (the document modulepreloads island chunks to warm the cache) — what the strategy gates is execution: nothing runs until this scrolls into view.</p>
            </div>
        </main>
    );
}, { name: 'App' });
