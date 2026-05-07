/**
 * Public SSR rendering APIs — convenience wrappers
 *
 * These delegate to `createSSR()` internally so there is exactly one
 * rendering pipeline.  When no plugins are registered the plugin hooks
 * are simply no-ops, making these equivalent to calling `createSSR()`
 * directly — but with a simpler call signature for the common case.
 *
 * For plugin-driven rendering (islands, streaming async, etc.),
 * use `createSSR().use(plugin).render()` from `@sigx/server-renderer`.
 *
 * Entry points:
 * - `renderToString()` — full render to a single string
 * - `renderToStream()` — ReadableStream
 * - `renderToNodeStream()` — Node.js Readable (faster on Node.js)
 * - `renderToStreamWithCallbacks()` — callback-based streaming
 */

import type { JSXElement } from 'sigx';
import type { App } from 'sigx';
import type { Readable } from 'node:stream';
import type { SSRContext, SSRContextOptions } from './context';
import { createSSR } from '../ssr';
import type { StreamCallbacks } from './types';

// Re-export StreamCallbacks from shared types (avoids circular dependency)
export type { StreamCallbacks } from './types';

/** Shared no-plugin instance — created once, reused for all standalone calls. */
const _defaultSSR = createSSR();

/**
 * Render JSX element or App to a ReadableStream.
 *
 * Internally delegates to `createSSR().renderStream()`.
 *
 * @example
 * ```tsx
 * // Simple usage with JSX
 * renderToStream(<App />)
 *
 * // With App instance for DI/plugins
 * const app = defineApp(<App />).use(router);
 * renderToStream(app)
 * ```
 */
export function renderToStream(input: JSXElement | App, context?: SSRContext): ReadableStream<string> {
    return _defaultSSR.renderStream(input, context);
}

/**
 * Render JSX element or App to a Node.js Readable stream.
 *
 * Faster than `renderToStream()` on Node.js because it bypasses WebStream
 * overhead entirely. Recommended for Express, Fastify, H3, and other
 * Node.js HTTP frameworks.
 *
 * @example
 * ```tsx
 * import { renderToNodeStream } from '@sigx/server-renderer/server';
 *
 * const stream = renderToNodeStream(<App />);
 * stream.pipe(res);
 * ```
 */
export function renderToNodeStream(input: JSXElement | App, context?: SSRContext): Readable {
    return _defaultSSR.renderNodeStream(input, context);
}

/**
 * Render with callbacks for fine-grained streaming control.
 *
 * Internally delegates to `createSSR().renderStreamWithCallbacks()`.
 *
 * @example
 * ```tsx
 * const app = defineApp(<App />).use(router);
 * await renderToStreamWithCallbacks(app, callbacks)
 * ```
 */
export async function renderToStreamWithCallbacks(
    input: JSXElement | App,
    callbacks: StreamCallbacks,
    context?: SSRContext
): Promise<void> {
    return _defaultSSR.renderStreamWithCallbacks(input, callbacks, context);
}

/**
 * Render JSX element or App to string.
 *
 * Internally delegates to `createSSR().render()`.
 *
 * @example
 * ```tsx
 * const html = await renderToString(<App />);
 *
 * const app = defineApp(<App />).use(router);
 * const html = await renderToString(app);
 * ```
 */
export async function renderToString(input: JSXElement | App, context?: SSRContext): Promise<string> {
    return _defaultSSR.render(input, context);
}
