/**
 * @sigx/resume/server
 *
 * Server half of the resume pack: the SSR plugin plus the tracking-signal
 * machinery it swaps into resumable components. WinterCG-clean — no `node:`
 * imports anywhere on this surface.
 */

export { resumePlugin } from '../plugin';
export type { ResumePluginOptions, ResumeManifest, ResumeChunkRef } from '../types';
export { createTrackingSignal, serializeSignalState } from './track-signal';
export type { ResumeSignalFn } from './track-signal';
export { createBoundaryRefresh } from './refresh';
export type {
    BoundaryRefreshOptions,
    BoundaryRefreshRequest,
    BoundaryRefreshEntry
} from './refresh';
