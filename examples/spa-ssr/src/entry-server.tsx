import { defineApp } from 'sigx';
import { renderToString } from '@sigx/server-renderer/server';
import { App } from './App';
import { createRouter, parseUrl, useRouter } from './router';

export async function render(url: string): Promise<{ html: string }> {
    // Per-request: fresh app + fresh router scoped to this URL. No module-level
    // state is shared between requests, so concurrent SSR can't interleave.
    const app = defineApp(<App />);
    app.defineProvide(useRouter, () => createRouter(parseUrl(url)));
    const html = await renderToString(app);
    return { html };
}
