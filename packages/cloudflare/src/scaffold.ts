/**
 * The scaffolded platform entry — written ONCE when absent, user-owned from
 * that moment (the wrangler.jsonc posture applied to the entry; PR #322).
 * Deliberately minimal: the server-fn mount ships as a commented block
 * because `virtual:sigx-server-fns` only resolves when `sigxServer()` is
 * configured. The block carries `renderBoundaries` too (#564): that option is
 * OPTIONAL, so an entry that omits it type-checks and silently loses
 * single-flight boundary refresh. The committed example entries are the full
 * reference (`examples/resume/src/entry.cloudflare.ts`, rfc-deploy §4.1).
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
        // import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
        // if (matchesServerFn(request, serverFnBase)) {
        //     return handleServerFnRequest(request, {
        //         base: serverFnBase,          // the build's own mount path
        //         resolve: (symbol) => serverFns[symbol]?.() ?? null,
        //         // Using @sigx/resume? Single-flight boundary refresh
        //         // (rfc-server §6.3) needs this option; without it a
        //         // mutation's response carries no fresh HTML and the
        //         // client pays a second round trip to converge:
        //         // renderBoundaries: createBoundaryRefresh({
        //         //     plugins: [resumePlugin({ manifest: resumeManifest })],
        //         //     components: { /* __resumeId -> server component */ }
        //         // })
        //     });
        // }
        return handler(request);
    }
};
`;
}
