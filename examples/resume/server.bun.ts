// The Bun production server (rfc-deploy §4.3) — a documented, copyable
// entry, not a package: Bun consumes the EXTERNAL build (the same `dist/`
// the Node server uses — Bun resolves node_modules and honors export
// conditions). Run after `pnpm build`:
//
//     bun --conditions=production server.bun.ts
//
// The composition order is the app's routing policy and stays visible here:
//
//     static assets  ->  server functions  ->  document render
//
// Statics are served with Bun.file — the runtime's own file responses
// (content-type, streaming); a sigx static server is a deliberate refusal
// (rfc-deploy §5.2).
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { resumePlugin } from '@sigx/resume';
import { createBoundaryRefresh } from '@sigx/resume/server';
// ONE import replaces four readFiles (rfc-deploy §3.2). The resume pack
// installs in the app factory (#413) — no SSR instance to build here.
// Boundary refresh is the ENDPOINT's side of resume, not the document's, so
// it is built below and needs the manifest here.
import { template, assets, resumeManifest } from './dist/server/sigx-app.js';
import { createApp, refreshComponents } from './dist/server/entry-server.js';
import { serverFns } from './dist/server/sigx-server-fns.js';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = resolve(fileURLToPath(new URL('./dist/client/', import.meta.url)));

const handler = createFetchHandler({
    template,
    app: (url: string) => createApp(url),
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

Bun.serve({
    port: Number(process.env.PORT) || 3000,
    async fetch(request: Request): Promise<Response> {
        const { pathname } = new URL(request.url);

        // Static tier: GET/HEAD-only (consistent with every other tier —
        // POSTs belong to the fn endpoint), exact file paths only (never
        // index.html — the raw outlet template must not shadow the document
        // render). The resolved prefix check guards ../ traversal; malformed
        // percent-encoding falls through to the render instead of throwing.
        if (
            (request.method === 'GET' || request.method === 'HEAD') &&
            pathname !== '/' &&
            !pathname.endsWith('/')
        ) {
            let decoded: string | undefined;
            try {
                decoded = decodeURIComponent(pathname);
            } catch {
                // Malformed encoding (e.g. /%FF) — not a file path.
            }
            if (decoded) {
                const filePath = resolve(join(clientDir, decoded));
                if (filePath.startsWith(clientDir + sep)) {
                    const file = Bun.file(filePath);
                    if (await file.exists()) return new Response(file);
                }
            }
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
});

console.log(`[resume] bun production server on http://localhost:${Number(process.env.PORT) || 3000}`);
