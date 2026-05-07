import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

type RenderFn = (url: string) => Promise<{ html: string }>;

async function createServer() {
    const app = express();

    let render: RenderFn;
    let template: string;

    if (!isProd) {
        // Dev: hand HTTP to Vite middleware, load entry-server via Vite SSR loader.
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            root: __dirname,
            server: { middlewareMode: true },
            appType: 'custom'
        });
        app.use(vite.middlewares);

        app.use('*', async (req, res, next) => {
            try {
                const url = req.originalUrl;
                const rawHtml = await readFile(resolve(__dirname, 'index.html'), 'utf-8');
                template = await vite.transformIndexHtml(url, rawHtml);
                const mod = await vite.ssrLoadModule('/src/entry-server.tsx');
                render = mod.render as RenderFn;

                const { html: appHtml } = await render(url);
                const html = template.replace('<!--ssr-outlet-->', appHtml);
                res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
            } catch (err) {
                next(err);
            }
        });
    } else {
        // Prod: serve built client assets and dynamically import the server bundle.
        const clientDir = resolve(__dirname, 'dist/client');
        template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const serverEntry = await import(resolve(__dirname, 'dist/server/entry-server.js') as string);
        render = serverEntry.render as RenderFn;

        app.use(express.static(clientDir, { index: false }));

        app.use('*', async (req, res, next) => {
            try {
                const { html: appHtml } = await render(req.originalUrl);
                const html = template.replace('<!--ssr-outlet-->', appHtml);
                res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
            } catch (err) {
                next(err);
            }
        });
    }

    app.listen(port, () => {
        console.log(`[spa-ssr] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
    });
}

createServer();
