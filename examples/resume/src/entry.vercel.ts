// The Vercel function entry (rfc-deploy §4.4) — user-owned, and THE
// documentation: the composition order is the app's routing policy and
// stays visible here:
//
//     static assets  ->  server functions  ->  document render
//
// Static assets never reach this code: config.json's filesystem handle
// serves them from static/ (the fn route runs before it, the catch-all
// after). The `export default { fetch }` shape is load-bearing on the Node
// runtime — the launcher detects a WEB handler by the fetch METHOD.
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { template, assets } from 'virtual:sigx-app';
import { serverFns } from 'virtual:sigx-server-fns';
// The resume pack installs in the app factory (#413) — its manifest arrives
// there via virtual:sigx-manifests; no SSR instance to build here.
import { createApp } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

export default {
    async fetch(request: Request): Promise<Response> {
        if (matchesServerFn(request)) {
            return handleServerFnRequest(request, {
                // The registry is explicitly passed, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null
            });
        }
        return handler(request);
    }
};
