import { defineApp } from 'sigx';
import { cachePlugin } from '@sigx/cache';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { App } from './App';
import { createRouter, parseUrl, routeChunks, useRouter } from './router';

// One router for the page. Initialised from the current URL so the first client
// render matches the server's HTML.
const app = defineApp(<App />);
// Cache policy for useData/useAction — the Data page's cache card uses it.
app.use(cachePlugin());
app.defineProvide(useRouter, () => createRouter(parseUrl(window.location.pathname)));

async function start() {
    // Settle the matched route's lazy chunks before the hydration walk
    // (docs/router-ssr-contract.md §2) — server-resolved <Defer> content
    // must hydrate against the real component. The route table owns the
    // route → chunk knowledge; no hardcoded paths here.
    await Promise.all(routeChunks(parseUrl(window.location.pathname)));
    // hydrate() exists once ssrClientPlugin is installed; the augmentation
    // keeps it optional on App, hence the `!` on the chained call.
    app.use(ssrClientPlugin).hydrate!('#app');
}

void start();
