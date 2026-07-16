import { defineApp } from 'sigx';
import { cachePlugin } from '@sigx/cache';
import { App } from './App';
import { createRouter, parseUrl, useRouter } from './router';

/**
 * The per-request app factory (the entry contract —
 * docs/router-ssr-contract.md §1): a FRESH app + router scoped to this URL.
 * No module-level state is shared between requests, so concurrent SSR can't
 * interleave. Both request handlers consume this export:
 * `createDevRequestHandler` (dev) and `createRequestHandler` (prod) own the
 * bot/stream dispatch, the shell status decision, and the template.
 */
export function createApp(url: string) {
    const app = defineApp(<App />);
    // Same plugin set as the client (the SSR provider seam outranks the
    // engine server-side, so this is inert during the render itself).
    app.use(cachePlugin());
    app.defineProvide(useRouter, () => createRouter(parseUrl(url)));
    return app;
}
