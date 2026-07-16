/**
 * @sigx/ssr-islands/server
 *
 * Server-side island utilities.
 */

export { createTrackingSignal, serializeSignalState } from './render-component';
export type { SSRSignalFn } from './render-component';
// Re-exported from core for existing import sites — the one escaping
// discipline lives in @sigx/server-renderer's shared serializer module.
export { escapeJsonForScript } from '@sigx/server-renderer/server';
