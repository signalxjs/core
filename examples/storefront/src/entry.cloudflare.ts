// The Cloudflare Worker entry (rfc-deploy §4.1) — the storefront variant:
// BOTH strategy packs, no server functions. The packs install in the app
// factory (entry-server.tsx, islands first — #413); manifests arrive there
// via virtual:sigx-manifests. Static assets never reach this code
// (wrangler's assets config serves them before the worker runs).
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { createApp } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

export default {
    fetch: (request: Request): Promise<Response> => handler(request)
};
