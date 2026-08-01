// The Deno production server (rfc-deploy §4.3) — a documented, copyable
// entry, not a package. Built BUNDLED (vite.config.deno.ts hand-rolls the
// SigxAdapter inline — a plain object, no @sigx/deno needed): Deno cannot
// select custom export conditions, so the prod dists are baked in at build
// time. Run after `pnpm build:deno`:
//
//     deno run --allow-net --allow-read --allow-env dist-deno/server/entry.deno.js
//
// The composition order is the app's routing policy and stays visible here:
//
//     static assets  ->  server functions  ->  document render
//
// Statics are served with the standard library's serveDir (404 falls
// through) — a sigx static server is a deliberate refusal (rfc-deploy §5.2).
import { serveDir } from 'jsr:@std/http@^1.0.0/file-server';
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { template, assets } from 'virtual:sigx-app';
import { serverFns } from 'virtual:sigx-server-fns';
import { resumePlugin } from '@sigx/resume';
import { createBoundaryRefresh } from '@sigx/resume/server';
import { resumeManifest } from 'virtual:sigx-manifests';
// The resume pack installs in the app factory (#413) — its manifest arrives
// there via virtual:sigx-manifests; no SSR instance to build here. Boundary
// refresh is the ENDPOINT's side of resume, not the document's, so it is
// built below.
import { createApp, refreshComponents } from './entry-server';

// Minimal ambient view of the Deno global — this file builds through Vite
// (no Deno type lib in the app tsconfig).
declare const Deno: {
    serve(
        options: { port?: number; onListen?: (addr: { port: number }) => void },
        handler: (request: Request) => Response | Promise<Response>
    ): unknown;
    env: { get(name: string): string | undefined };
};

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
// after all. The re-render runs the same plugin set the page rendered with,
// explicit like the registry. An app with app-level DI the re-render must
// see (serverPlugin({ types }), provideTypeHandlers) passes
// `app: (rq) => createApp(...)` instead, and the app's plugins win.
const renderBoundaries = createBoundaryRefresh({
    plugins: [resumePlugin({ manifest: resumeManifest })],
    components: refreshComponents
});

Deno.serve(
    {
        port: Number(Deno.env.get('PORT') ?? 8000),
        onListen: ({ port }) => console.log(`[resume] deno production server on http://localhost:${port}`)
    },
    async (request: Request): Promise<Response> => {
        // Static tier is GET/HEAD-only: serveDir answers other methods with
        // 405 (not 404), which would swallow server-fn POSTs. showIndex:
        // false — serveDir must never serve the raw outlet template
        // (index.html) for '/'; documents belong to the render.
        if (request.method === 'GET' || request.method === 'HEAD') {
            const res = await serveDir(request, {
                fsRoot: 'dist-deno/client',
                quiet: true,
                showIndex: false
            });
            if (res.status !== 404) return res;
        }

        if (matchesServerFn(request)) {
            return handleServerFnRequest(request, {
                // The registry is explicitly passed, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null,
                renderBoundaries
            });
        }

        return handler(request);
    }
);
