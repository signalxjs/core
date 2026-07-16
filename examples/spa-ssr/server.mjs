// The reference SSR server (rfc-ssr-platform §3.3) — plain Node, no
// transpiler: dev is Vite middleware + one handler, prod is static assets +
// one handler. Run production with `--conditions production` to get the
// NODE_ENV-stripped dist builds (works without it too).
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

// Crawlers and AI agents get the blocking document: complete content inline,
// no placeholders, nothing for the client to execute.
const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function createServer() {
    const app = express();

    if (!isProd) {
        // Dev: Vite middleware + ONE handler — template transform,
        // per-request entry load, stack mapping, and the bot/stream/status
        // dispatch all live inside it.
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
        // Prod: static assets + ONE handler over the built entry, with
        // manifest-fed modulepreload/stylesheet links per request.
        const { createRequestHandler } = await import('@sigx/server-renderer/node');
        const { collectAssets } = await import('@sigx/vite/ssr');

        const clientDir = resolve(__dirname, 'dist/client');
        const template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const manifest = JSON.parse(
            await readFile(resolve(clientDir, '.vite/manifest.json'), 'utf-8')
        );
        const { createApp } = await import(
            pathToFileURL(resolve(__dirname, 'dist/server/entry-server.js')).href
        );

        // The matched route's lazy chunks preload from the shell
        // (docs/router-ssr-contract.md §2) — mapped through the client
        // manifest. Boundary chunks are preloaded automatically.
        const ROUTE_MODULES = {
            '/about': ['src/sections/TechDetails.tsx']
        };
        const routePath = (url) => url.split('?')[0].split('#')[0];

        app.use(express.static(clientDir, { index: false }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            document: (url) => ({
                assets: collectAssets(manifest, ROUTE_MODULES[routePath(url)] ?? [])
            })
        }));
    }

    app.listen(port, () => {
        console.log(`[spa-ssr] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
