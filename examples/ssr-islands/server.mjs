// The islands reference server (rfc-ssr-platform §3.3) — same two-mode shape
// as examples/spa-ssr/server.mjs. The islands pack installs in the app
// factory (src/entry-server.tsx, #413: app.use is the one install shape),
// so this wiring is pure transport: no SSR instance, no manifests to thread.
// Run production with `--conditions production` for the NODE_ENV-stripped
// dist builds (works without it too).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

// Crawlers get the blocking document: complete content, nothing to execute.
const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function createServer() {
    const app = express();

    if (!isProd) {
        // Dev: Vite middleware + ONE handler. The app factory carries the
        // islands pack; no manifest in dev — the client resolves island
        // chunks through the loaders `virtual:sigx-islands` registers.
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
        // Prod: static assets + ONE handler. Vite's client manifest feeds
        // entry preloads; the islands manifest reaches the pack inside the
        // app factory via virtual:sigx-manifests — nothing to read here.
        const { createRequestHandler } = await import('@sigx/server-renderer/node');
        const { collectAssets } = await import('@sigx/vite/ssr');

        const clientDir = resolve(__dirname, 'dist/client');
        const template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const manifest = JSON.parse(
            await readFile(resolve(clientDir, '.vite/manifest.json'), 'utf-8')
        );
        const { createApp } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );

        app.use(express.static(clientDir, { index: false }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            document: {
                assets: collectAssets(manifest, ['index.html'])
            }
        }));
    }

    app.listen(port, () => {
        console.log(`[islands] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
