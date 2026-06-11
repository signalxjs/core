import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { RenderResult, RenderOpts } from './src/entry-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

type RenderFn = (url: string, template: string, opts: RenderOpts) => RenderResult;

// Crawlers and AI agents get the blocking document: complete content inline,
// no placeholders, nothing for the client to execute.
const BOT_UA = /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i;

async function handle(
    req: express.Request,
    res: express.Response,
    render: RenderFn,
    template: string
): Promise<void> {
    const bot = BOT_UA.test(req.get('user-agent') ?? '');
    const result = render(req.originalUrl, template, { bot });

    if (result.kind === 'blocking') {
        res.status(200).set({ 'Content-Type': 'text/html' }).end(await result.html);
        return;
    }

    // Status-code decision point: the shell promise settles before any byte
    // is produced. Reject -> we can still send a proper 500 page.
    try {
        await result.shell;
    } catch (err) {
        console.error('[spa-ssr] shell render failed:', err);
        res.status(500).set({ 'Content-Type': 'text/html' })
            .end('<!doctype html><h1>500 — render failed</h1>');
        return;
    }
    res.status(200).set({ 'Content-Type': 'text/html' });
    result.stream.pipe(res);
}

async function createServer() {
    const app = express();

    if (!isProd) {
        // Dev: hand HTTP to Vite middleware, load entry-server via Vite SSR loader.
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            root: __dirname,
            server: { middlewareMode: true },
            appType: 'custom'
        });
        app.use(vite.middlewares);

        // NOTE: express 5 (path-to-regexp 8) no longer accepts '*' as a path —
        // a bare use() matches everything.
        app.use(async (req, res, next) => {
            try {
                const url = req.originalUrl;
                const rawHtml = await readFile(resolve(__dirname, 'index.html'), 'utf-8');
                const template = await vite.transformIndexHtml(url, rawHtml);
                const mod = await vite.ssrLoadModule('/src/entry-server.tsx');
                await handle(req, res, mod.render as RenderFn, template);
            } catch (err) {
                next(err);
            }
        });
    } else {
        // Prod: serve built client assets and dynamically import the server bundle.
        const clientDir = resolve(__dirname, 'dist/client');
        const template = await readFile(resolve(clientDir, 'index.html'), 'utf-8');
        const serverEntry = await import(resolve(__dirname, 'dist/server/entry-server.js') as string);
        const render = serverEntry.render as RenderFn;

        app.use(express.static(clientDir, { index: false }));

        app.use(async (req, res, next) => {
            try {
                await handle(req, res, render, template);
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
