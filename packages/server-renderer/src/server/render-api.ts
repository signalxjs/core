/**
 * Public SSR rendering APIs — convenience wrappers
 *
 * These delegate to `createSSR()` internally so there is exactly one
 * rendering pipeline.  When no plugins are registered the plugin hooks
 * are simply no-ops, making these equivalent to calling `createSSR()`
 * directly — but with a simpler call signature for the common case.
 *
 * For plugin-driven rendering (islands, resume, etc.), install the pack on
 * the app — `defineApp(<App />).use(pack())` — and pass the App here or to
 * `createSSR().render()`; app-carried plugins are merged in per render.
 *
 * Entry points:
 * - `renderToString()` — full render to a single string
 * - `renderToStream()` — ReadableStream
 * - `renderToStreamWithCallbacks()` — callback-based streaming
 *
 * Node Readable shapes (`renderToNodeStream`, `renderDocumentToNodeStream`)
 * live in `@sigx/server-renderer/node` — this entry is WinterCG-clean.
 */

import type { JSXElement } from 'sigx';
import type { App } from 'sigx';
import type { SSRContext } from './context';
import { createSSR } from '../ssr';
import type { StreamCallbacks } from './types';
import type { DocumentOptions } from './document';

// Re-export StreamCallbacks from shared types (avoids circular dependency)
export type { StreamCallbacks } from './types';

/**
 * Shared no-plugin instance — created once, reused for all standalone calls
 * and as the default of the fetch/Node request handlers. Internal export;
 * not part of the public barrel.
 */
export const defaultSSR = createSSR();

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
    return defaultSSR.renderStream(input, context);
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
    return defaultSSR.renderStreamWithCallbacks(input, callbacks, context);
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
    return defaultSSR.render(input, context);
}

/**
 * Render a complete HTML document from a template — head auto-injection,
 * state serialization (default on), async content inlined.
 * Default mode: 'blocking' (crawler/AI-agent friendly full content).
 *
 * @example
 * ```tsx
 * const html = await renderDocument(app, { template, mode: isBot ? 'blocking' : 'stream' });
 * ```
 */
export function renderDocument(input: JSXElement | App, options: DocumentOptions): Promise<string> {
    return defaultSSR.renderDocument(input, options);
}

/** Stream a complete HTML document as UTF-8 bytes (edge runtimes / Response body). */
export function renderDocumentToWebStream(
    input: JSXElement | App,
    options: DocumentOptions
): ReadableStream<Uint8Array> {
    return defaultSSR.renderDocumentToWebStream(input, options);
}
