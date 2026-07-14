/**
 * @sigx/server-renderer/server
 * 
 * Server-side rendering with streaming support and hydration markers.
 * Strategy-agnostic — plugins add islands, deferred boundaries, etc.
 */

// Load SSR type augmentations (SSRHelper, ComponentSetupContext extensions)
import '../client-directives.js';

export { renderToStream, renderToNodeStream, renderToString, renderToStreamWithCallbacks } from './render-api';
export { renderDocument, renderDocumentToNodeStream, renderDocumentToWebStream } from './render-api';
export type { DocumentOptions } from './document';
export { renderVNodeToString } from './render-core';
export { createSSRContext } from './context';
export type { SSRContext, SSRContextOptions, RenderOptions, CorePendingAsync } from './context';
export { generateStreamingScript, generateReplacementScript, escapeJsonForScript, generateAppendBootstrap, generateAppendScript } from './streaming';
export type { StreamCallbacks } from './types';
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
export type { SSRTypeHandler } from './serialize';
export type {
    SSRBoundary,
    SSRBoundaryRecord,
    ResolvedBoundary,
    BoundaryFlush,
    BoundaryHydrate
} from '../boundary';
