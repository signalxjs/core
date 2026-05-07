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

// SSR directive type augmentation — adds getSSRProps to DirectiveDefinition
import './directive-ssr-types.js';

// Patch getSSRProps onto built-in directives (show, etc.)
import { initDirectivesForSSR } from './builtin-ssr-directives.js';
initDirectivesForSSR();

// Plugin system
export { createSSR } from './ssr.js';
export type { SSRInstance } from './ssr.js';
export type { SSRPlugin } from './plugin.js';

// Re-export from server (convenience)
export { renderToStream, renderToString, renderVNodeToString } from './server/index.js';
export { createSSRContext } from './server/context.js';
export type { SSRContext, SSRContextOptions, RenderOptions, CorePendingAsync } from './server/context.js';

// Re-export from client (convenience)
export { ssrClientPlugin } from './client/index.js';

// SSR types (shared across server-renderer and plugins)
export type { SSRHelper } from './client-directives.js';
export type { SSRSignalFn } from './server/types.js';
export { generateSignalKey } from './server/types.js';

// Head management
export { useHead, renderHeadToString, enableSSRHead, collectSSRHead } from './head.js';
export type { HeadConfig, HeadMeta, HeadLink, HeadScript } from './head.js';
