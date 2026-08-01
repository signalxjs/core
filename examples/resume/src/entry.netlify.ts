// The Netlify function entry (rfc-deploy §4.5) — user-owned, and THE
// documentation: the composition order is the app's routing policy and
// stays visible here:
//
//     static assets  ->  server functions  ->  document render
//
// Static assets never reach this code: the generated function config sets
// preferStatic, so CDN files win before the catch-all runs. The Netlify v2
// contract (bare default fn + in-source config) lives in the GENERATED
// wrapper — this entry keeps the { fetch } shape shared by every platform.
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { template, assets } from 'virtual:sigx-app';
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
import { resumePlugin } from '@sigx/resume';
import { createBoundaryRefresh } from '@sigx/resume/server';
import { resumeManifest } from 'virtual:sigx-manifests';
// The resume pack installs in the app factory (#413) — its manifest arrives
// there via virtual:sigx-manifests; no SSR instance to build here. Boundary
// refresh is the ENDPOINT's side of resume, not the document's, so it is
// built below.
import { createApp, refreshComponents } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

// Single-flight boundary refresh (rfc-server §6.3): a mutation's response
// carries the freshly rendered HTML of every boundary whose recorded data
// deps its `invalidates` names. WITHOUT this option the endpoint silently
// skips the whole block and the client falls back to $cache revalidation —
// a working page, one round trip slower, and the component chunk loads
// after all. Built once per isolate; the re-render runs the same plugin set
// the page rendered with, explicit like the registry. An app with app-level
// DI the re-render must see (serverPlugin({ types }), provideTypeHandlers)
// passes `app: (rq) => createApp(...)` instead, and the app's plugins win.
const renderBoundaries = createBoundaryRefresh({
    plugins: [resumePlugin({ manifest: resumeManifest })],
    components: refreshComponents
});

export default {
    async fetch(request: Request): Promise<Response> {
        if (matchesServerFn(request, serverFnBase)) {
            return handleServerFnRequest(request, {
                // The build's own mount path, so the router above and the
                // handler here cannot disagree (#563).
                base: serverFnBase,
                // The registry is explicitly passed, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null,
                renderBoundaries
            });
        }
        return handler(request);
    }
};
