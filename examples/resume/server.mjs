// The resumability reference server (#241) — same two-mode shape as
// examples/ssr-islands/server.mjs. The resume pack installs in the app
// factory (src/entry-server.tsx, #413: app.use is the one install shape);
// this wiring is transport plus the server-fn endpoint.
// Run production with `--conditions production` for the NODE_ENV-stripped
// dist builds (works without it too).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

// Crawlers get the blocking document: complete content, nothing to execute.
const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function createServer() {
    const app = express();

    if (!isProd) {
        // Dev: Vite middleware + ONE handler. The app factory carries the
        // resume pack; no manifest in dev — QRLs and upgrade chunks resolve
        // through the virtual registry. (Boundary refresh in dev rides
        // src/dev-refresh.ts through sigxServer()'s middleware.)
        const { createServer: createViteServer } = await import('vite');
        const { createDevRequestHandler } = await import('@sigx/vite/ssr');

        const vite = await createViteServer({
            root: __dirname,
            server: { middlewareMode: true },
            appType: 'custom'
        });
        app.use(vite.middlewares);
        app.use(await createDevRequestHandler(vite, {
            entry: '/src/entry-server.tsx',
            isBot
        }));
    } else {
        // Prod: static assets + the server-function endpoint + ONE document
        // handler. ONE import replaces four readFiles + inline collectAssets
        // (rfc-deploy §3.2): the build materializes template/assets/manifests
        // as dist/server/sigx-app.js. The fn registry stays its own import —
        // explicitly passed, never ambient. (In dev, vite.middlewares
        // carries the fn endpoint — sigxServer()'s configureServer
        // middleware.)
        const { createRequestHandler } = await import('@sigx/server-renderer/node');
        const { createServerFnHandler } = await import('@sigx/server/node');
        const { createBoundaryRefresh } = await import('@sigx/resume/server');
        const { resumePlugin } = await import('@sigx/resume');

        const { template, assets, resumeManifest } = await import(
            new URL('./dist/server/sigx-app.js', import.meta.url).href
        );
        const { createApp, refreshComponents } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );
        const { serverFns } = await import(
            new URL('./dist/server/sigx-server-fns.js', import.meta.url).href
        );

        app.use(express.static(resolve(__dirname, 'dist/client'), { index: false }));
        // Single-flight boundary refreshes (rfc-server §6.3) re-render
        // through the same plugin set the page rendered with — explicit
        // here, matching the endpoint's explicit-registry posture.
        app.use(createServerFnHandler({
            functions: serverFns,
            renderBoundaries: createBoundaryRefresh({
                plugins: [resumePlugin({ manifest: resumeManifest })],
                components: refreshComponents
            })
        }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            document: { assets }
        }));
    }

    app.listen(port, () => {
        console.log(`[resume] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
