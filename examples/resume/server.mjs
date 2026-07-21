// The resumability reference server (#241) — same two-mode shape as
// examples/ssr-islands/server.mjs, with resumePlugin() on the SSR instance.
// Run production with `--conditions production` for the NODE_ENV-stripped
// dist builds (works without it too).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSSR } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

// Crawlers get the blocking document: complete content, nothing to execute.
const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function createServer() {
    const app = express();

    if (!isProd) {
        // Dev: Vite middleware + ONE handler. The @sigx family is
        // externalized from the runner (vite.config.ts), so this module's
        // resumePlugin() import and the handler's renderer are the same
        // instances — one module graph. No manifest in dev: QRLs and
        // upgrade chunks resolve through the virtual registry.
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
            isBot,
            ssr: createSSR().use(resumePlugin())
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

        const { template, assets, resumeManifest } = await import(
            new URL('./dist/server/sigx-app.js', import.meta.url).href
        );
        const { createApp, refreshComponents } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );
        const { serverFns } = await import(
            new URL('./dist/server/sigx-server-fns.js', import.meta.url).href
        );

        // ONE ssr instance for documents AND single-flight boundary
        // refreshes (rfc-server §6.3) — the refresh re-renders through the
        // same plugin set the page rendered with.
        const ssr = createSSR().use(resumePlugin({ manifest: resumeManifest }));

        app.use(express.static(resolve(__dirname, 'dist/client'), { index: false }));
        app.use(createServerFnHandler({
            functions: serverFns,
            renderBoundaries: createBoundaryRefresh({ ssr, components: refreshComponents })
        }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            ssr,
            document: { assets }
        }));
    }

    app.listen(port, () => {
        console.log(`[resume] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
