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
// The resume pack installs in the app factory (#413) — its manifest arrives
// there via virtual:sigx-manifests; no SSR instance to build here.
import { createApp } from './entry-server';

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
                resolve: (symbol) => serverFns[symbol]?.() ?? null
            });
        }

        return handler(request);
    }
);
