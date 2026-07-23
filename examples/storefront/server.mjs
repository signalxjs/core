// The storefront showcase server (#265): BOTH strategy packs — resumePlugin
// for the ~48 product cards/forms, islandsPlugin for the cart badge + HUD.
// They install in the app factory (src/entry-server.tsx, islands first —
// #413: app.use is the one install shape); this wiring is pure transport.
// Run production with `--conditions production`.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function createServer() {
    const app = express();

    if (!isProd) {
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
        const { createRequestHandler } = await import('@sigx/server-renderer/node');

        // ONE import replaces four readFiles + inline collectAssets
        // (rfc-deploy §3.2): the build materializes template/assets as
        // dist/server/sigx-app.js. The pack manifests reach the packs inside
        // the app factory via virtual:sigx-manifests — nothing to thread.
        const { template, assets } = await import(
            new URL('./dist/server/sigx-app.js', import.meta.url).href
        );
        const { createApp } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );

        app.use(express.static(resolve(__dirname, 'dist/client'), { index: false }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            document: { assets }
        }));
    }

    app.listen(port, () => {
        console.log(`[storefront] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
