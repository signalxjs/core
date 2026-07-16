// The storefront showcase server (#265): BOTH strategy packs on one SSR
// instance — resumePlugin for the ~48 product cards/forms, islandsPlugin for
// the cart badge + HUD. Run production with `--conditions production`.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createSSR } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume';
import { islandsPlugin } from '@sigx/ssr-islands';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf-8'));
    } catch {
        return undefined;
    }
}

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
            isBot,
            // Islands first: client:* usage sites are theirs by convention.
            ssr: createSSR().use(islandsPlugin()).use(resumePlugin())
        }));
    } else {
        const { createRequestHandler } = await import('@sigx/server-renderer/node');
        const { collectAssets } = await import('@sigx/vite/ssr');

        const clientDir = resolve(__dirname, 'dist/client');
        const template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const manifest = await readJson(resolve(clientDir, '.vite/manifest.json'));
        const resumeManifest = await readJson(resolve(clientDir, '.vite/sigx-resume-manifest.json'));
        const islandsManifest = await readJson(resolve(clientDir, '.vite/sigx-islands-manifest.json'));
        const { createApp } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );

        app.use(express.static(clientDir, { index: false }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            ssr: createSSR()
                .use(islandsPlugin({ manifest: islandsManifest }))
                .use(resumePlugin({ manifest: resumeManifest })),
            document: {
                assets: collectAssets(manifest, ['index.html'])
            }
        }));
    }

    app.listen(port, () => {
        console.log(`[storefront] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
