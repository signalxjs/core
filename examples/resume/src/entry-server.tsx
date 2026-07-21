import { defineApp } from 'sigx';
import { App } from './App';
import { requestSummary } from './api.server';

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
