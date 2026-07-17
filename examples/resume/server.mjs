// The resumability reference server (#241) — same two-mode shape as
// examples/ssr-islands/server.mjs, with resumePlugin() on the SSR instance.
// Run production with `--conditions production` for the NODE_ENV-stripped
// dist builds (works without it too).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
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
        // handler, with BOTH manifests — Vite's client manifest feeds entry
        // preloads, the resume manifest feeds per-component upgrade-chunk
        // URLs into the boundary table. (In dev, vite.middlewares carries
        // the fn endpoint — sigxServer()'s configureServer middleware.)
        const { createRequestHandler } = await import('@sigx/server-renderer/node');
        const { createServerFnHandler } = await import('@sigx/server/node');
        const { collectAssets } = await import('@sigx/vite/ssr');

        const clientDir = resolve(__dirname, 'dist/client');
        const template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const manifest = JSON.parse(
            await readFile(resolve(clientDir, '.vite/manifest.json'), 'utf-8')
        );
        const resumeManifest = JSON.parse(
            await readFile(resolve(clientDir, '.vite/sigx-resume-manifest.json'), 'utf-8')
        );
        const { createApp } = await import(
            new URL('./dist/server/entry-server.js', import.meta.url).href
        );
        const { serverFns } = await import(
            new URL('./dist/server/sigx-server-fns.js', import.meta.url).href
        );

        app.use(express.static(clientDir, { index: false }));
        app.use(createServerFnHandler({ functions: serverFns }));
        app.use(createRequestHandler({
            template,
            app: (url) => createApp(url),
            isBot,
            ssr: createSSR().use(resumePlugin({ manifest: resumeManifest })),
            document: {
                assets: collectAssets(manifest, ['index.html'])
            }
        }));
    }

    app.listen(port, () => {
        console.log(`[resume] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
