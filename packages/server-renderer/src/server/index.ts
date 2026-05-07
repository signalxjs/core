/**
 * @sigx/server-renderer/server
 * 
 * Server-side rendering with streaming support and hydration markers.
 * Strategy-agnostic — plugins add islands, Suspense, etc.
 */

// Load SSR type augmentations (SSRHelper, ComponentSetupContext extensions)
import '../client-directives.js';

// Load SSR directive type augmentation (adds getSSRProps to DirectiveDefinition)
import '../directive-ssr-types.js';

// Patch getSSRProps onto built-in directives (show, etc.)
import { initDirectivesForSSR } from '../builtin-ssr-directives.js';
initDirectivesForSSR();

export { renderToStream, renderToNodeStream, renderToString, renderToStreamWithCallbacks } from './render-api';
export { renderVNodeToString } from './render-core';
export { createSSRContext } from './context';
export type { SSRContext, SSRContextOptions, RenderOptions, CorePendingAsync } from './context';
export { generateStreamingScript, generateReplacementScript, escapeJsonForScript } from './streaming';
export type { SSRSignalFn, StreamCallbacks } from './types';
export { generateSignalKey } from './types';
