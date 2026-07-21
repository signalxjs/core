import { defineApp } from 'sigx';
import { App } from './App';
import { Poll } from './resume/Poll';
import { requestSummary } from './api.server';

/**
 * The boundary-refresh registry (rfc-server §6.3): registry key → server
 * component, explicitly passed to `createBoundaryRefresh` — same posture as
 * the server-fn registry, never ambient. Keys are the components'
 * transform-stamped `__resumeId` (the export name).
 */
export const refreshComponents = { Poll };

/**
 * Per-request app factory (docs/router-ssr-contract.md §1).
 *
 * The `await` is a server function called IN-PROCESS — a direct invocation,
 * no HTTP hop. It reads the live document request through the ambient scope
 * every handler opens around a render (rfc-server §7 v1.1, #309); the same
 * function called from the browser goes over the wire instead.
 */
export async function createApp(_url: string) {
    return defineApp(<App ssrRequest={await requestSummary()} />);
}
