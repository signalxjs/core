/**
 * @sigx/server-renderer
 * 
 * Server-side rendering and client-side hydration for SigX applications.
 * Strategy-agnostic core — extend with plugins for custom hydration strategies,
 * resumable SSR, etc.
 * 
 * ## Server Usage
 * ```ts
 * import { renderToStream, renderToString } from '@sigx/server-renderer/server';
 * 
 * // Streaming (recommended)
 * const stream = renderToStream(<App />);
 * 
 * // Or string
 * const html = await renderToString(<App />);
 * ```
 * 
 * ## Plugin-driven rendering (recommended for custom strategies, async, etc.)
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * 
 * const ssr = createSSR().use(myPlugin);
 * const html = await ssr.render(<App />);
 * ```
 * 
 * ## Client Usage
 * ```ts
 * import { defineApp } from 'sigx';
 * import { ssrClientPlugin } from '@sigx/server-renderer/client';
 * 
 * defineApp(<App />)
 *     .use(ssrClientPlugin)
 *     .hydrate('#root');
 * ```
 * 
 * @module
 */

// Plugin system
export { createSSR } from './ssr.js';
export type { SSRInstance } from './ssr.js';
export type { SSRPlugin } from './plugin.js';

// Re-export from server (convenience)
export { renderToStream, renderToString, renderVNodeToString } from './server/index.js';
export { renderDocument, renderDocumentToWebStream } from './server/index.js';
export type { DocumentOptions } from './server/document.js';
export { createSSRContext } from './server/context.js';
export type { SSRContext, SSRContextOptions, RenderOptions, CorePendingAsync, SSRErrorInfo } from './server/context.js';

// The boundary model (rfc-ssr-platform §1)
export type {
    SSRBoundary,
    SSRBoundaryRecord,
    ResolvedBoundary,
    BoundaryFlush,
    BoundaryHydrate
} from './boundary.js';

// Re-export from client (convenience)
export { ssrClientPlugin } from './client/index.js';

// SSR types (shared across server-renderer and plugins)
export type { SSRHelper } from './client-directives.js';

// State serialization (__SIGX_ASYNC__ transfer for useAsync/useStream;
// opt-in plugin — automatic under renderDocument)
export { stateSerializationPlugin } from './server/state-plugin.js';

// Per-request response seam (useResponse — inert on the client)
export { useResponse } from './response.js';
export type { ResponseRecorder, SSRResponse } from './response.js';

// Server-side head rendering (useHead itself lives in sigx)
export { renderHeadToString } from './head.js';
