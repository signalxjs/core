/**
 * @sigx/server-renderer/server
 * 
 * Server-side rendering with streaming support and hydration markers.
 * Strategy-agnostic — plugins add islands, deferred boundaries, etc.
 */

// Load SSR type augmentations (SSRHelper, ComponentSetupContext extensions)
import '../client-directives.js';

export { renderToStream, renderToString, renderToStreamWithCallbacks } from './render-api';
export { renderDocument, renderDocumentToWebStream } from './render-api';
export { createFetchHandler } from './fetch-handler';
export type { FetchHandlerOptions, FetchHandler } from './fetch-handler';
export { defaultIsBot } from './bot';
export { chunksToBytes } from './bytes';
export type { DocumentOptions } from './document';
export { renderVNodeToString, defaultRenderError } from './render-core';
export { createSSRContext } from './context';
export type { SSRContext, SSRContextOptions, RenderOptions, CorePendingAsync, SSRErrorInfo } from './context';
export { generateStreamingScript, generateReplacementScript, escapeJsonForScript, generateAppendBootstrap, generateAppendScript } from './streaming';
export type { StreamCallbacks } from './types';
export { useResponse, responseSummary } from '../response';
export type { ResponseRecorder, ResponseState, SSRResponse } from '../response';
export { stateSerializationPlugin } from './state-plugin';
export { serializeAsyncScript, asyncAssignmentJs } from './state';
export {
    assignmentJs,
    stringifyWithHandlers,
    serializeBoundaryProps,
    getTypeHandlers,
    isSerializable,
    DANGEROUS_KEYS,
    emitBoundaryTable,
    boundaryPatchJs
} from './serialize';
export type { TypeHandler } from './serialize';
export { createTrackingSignal, serializeSignalState } from './state-signals';
export { mergeSSRPlugins, initPluginContext } from './plugin-setup';
// The app-carried plugin seam (DOM-free; lives under client/ so install(app)
// can run in any bundle) — re-exported here so server-side consumers (packs'
// boundary refresh, custom engines) see one barrel.
export { SSR_PLUGINS_TOKEN, provideSSRPlugin, getSSRPlugins } from '../client/ssr-plugins';
export type { StateSignalFn } from './state-signals';
export type {
    SSRBoundary,
    SSRBoundaryRecord,
    ResolvedBoundary,
    BoundaryFlush,
    BoundaryHydrate
} from '../boundary';
