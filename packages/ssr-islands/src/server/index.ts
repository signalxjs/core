/**
 * @sigx/ssr-islands/server
 *
 * Server-side island utilities.
 */

export { createTrackingSignal, serializeSignalState } from './render-component';
export type { SSRSignalFn } from './render-component';
export {
    escapeJsonForScript,
    generateIslandDataScript
} from './render-islands';
