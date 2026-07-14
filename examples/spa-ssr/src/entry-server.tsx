import { defineApp } from 'sigx';
import { cachePlugin } from '@sigx/cache';
import { renderDocument } from '@sigx/server-renderer/server';
import { renderDocumentToNodeStream } from '@sigx/server-renderer/node';
import type { Readable } from 'node:stream';
import { App } from './App';
import { createRouter, parseUrl, useRouter } from './router';

export interface RenderOpts {
    /** Complete HTML for crawlers/AI agents: no placeholders, no scripts to run. */
    bot: boolean;
}

export type RenderResult =
    | { kind: 'blocking'; html: Promise<string> }
    | { kind: 'stream'; stream: Readable; shell: Promise<void> };

export function render(url: string, template: string, opts: RenderOpts): RenderResult {
    // Per-request: fresh app + fresh router scoped to this URL. No module-level
    // state is shared between requests, so concurrent SSR can't interleave.
    const app = defineApp(<App />);
    // Same plugin set as the client (the SSR provider seam outranks the
    // engine server-side, so this is inert during the render itself).
    app.use(cachePlugin());
    app.defineProvide(useRouter, () => createRouter(parseUrl(url)));

    if (opts.bot) {
        // Blocking document: every useData()/useStream() resolves inline —
        // crawlers and AI agents get the full content with zero client JS work.
        return { kind: 'blocking', html: renderDocument(app, { template, mode: 'blocking' }) };
    }

    // Streaming document: head + shell flush immediately (async content as
    // placeholders), data and AI tokens stream in afterwards. `shell` settles
    // before the first byte — the server uses it to pick the status code.
    const { stream, shell } = renderDocumentToNodeStream(app, { template });
    return { kind: 'stream', stream, shell };
}
