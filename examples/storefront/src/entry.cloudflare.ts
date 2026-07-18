// The Cloudflare Worker entry (rfc-deploy §4.1) — the storefront variant:
// BOTH strategy packs on one SSR instance, no server functions. The
// composition stays visible; static assets never reach this code (wrangler's
// assets config serves them before the worker runs).
import { createFetchHandler } from '@sigx/server-renderer/server';
import { createSSR } from '@sigx/server-renderer';
import { islandsPlugin } from '@sigx/ssr-islands';
import { resumePlugin } from '@sigx/resume';
import { template, assets, islandsManifest, resumeManifest } from 'virtual:sigx-app';
import { createApp } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    // Islands first: client:* usage sites are theirs by convention.
    ssr: createSSR()
        .use(islandsPlugin({ manifest: islandsManifest }))
        .use(resumePlugin({ manifest: resumeManifest })),
    document: { assets }
});

export default {
    fetch: (request: Request): Promise<Response> => handler(request)
};
