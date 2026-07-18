// The Cloudflare Worker entry (rfc-deploy §4.1) — user-owned, and THE
// documentation: the composition order is the app's routing policy and
// stays visible here:
//
//     static assets  ->  server functions  ->  document render
//
// Static assets never reach this code: wrangler's assets config (see
// wrangler.jsonc) serves matching files before the worker is invoked.
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { createSSR } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume';
import { template, assets, resumeManifest } from 'virtual:sigx-app';
import { serverFns } from 'virtual:sigx-server-fns';
import { createApp } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    ssr: createSSR().use(resumePlugin({ manifest: resumeManifest })),
    document: { assets }
});

export default {
    async fetch(request: Request): Promise<Response> {
        if (matchesServerFn(request)) {
            return handleServerFnRequest(request, {
                // The registry is explicitly passed, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null
                // origin/guard postures for cross-origin native clients:
                // rfc-server rev 2 §5 (default stays 'same-origin').
            });
        }
        return handler(request);
    }
};
