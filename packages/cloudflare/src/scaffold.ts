/**
 * The scaffolded platform entry — written ONCE when absent, user-owned from
 * that moment (the wrangler.jsonc posture applied to the entry; PR #322).
 * Deliberately minimal: the server-fn mount ships as a commented block
 * because `virtual:sigx-server-fns` only resolves when `sigxServer()` is
 * configured. The committed example entries are the full reference
 * (rfc-deploy §4.1).
 */
export function scaffoldEntry(ssrEntryImport: string): string {
    return `// Cloudflare Worker entry — scaffolded by @sigx/cloudflare, YOURS from here
// on (rebuilds never touch it). The composition order is the app's routing
// policy and stays visible in this file:
//
//     static assets  ->  server functions  ->  document render
//
// Static assets never reach this code: wrangler's assets config serves
// matching files before the worker runs.
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { createApp } from '${ssrEntryImport}';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

export default {
    async fetch(request: Request): Promise<Response> {
        // Using server functions (sigxServer() in vite.config)? Mount the
        // endpoint BEFORE the document render:
        //
        // import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
        // import { serverFns } from 'virtual:sigx-server-fns';
        // if (matchesServerFn(request)) {
        //     return handleServerFnRequest(request, {
        //         resolve: (symbol) => serverFns[symbol]?.() ?? null
        //     });
        // }
        return handler(request);
    }
};
`;
}
