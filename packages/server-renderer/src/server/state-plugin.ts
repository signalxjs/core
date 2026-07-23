/**
 * Built-in state serialization plugin.
 *
 * Ships the values resolved by useAsync/useStream — and anything packs
 * register via `ctx.registerSerializedState` (#407) — to the client as
 * `window.__SIGX_ASYNC__`, keyed by the calls' explicit keys. The client
 * composables consume the blob on first use, so fetchers don't re-run after
 * hydration — no duplicate requests, no flicker.
 *
 * Opt-in: `createSSR({ plugins: [stateSerializationPlugin()] })`. The
 * `renderDocument` API enables it by default.
 *
 * Emission points (each drains `ctx._unflushedAsyncKeys`, so every key ships
 * exactly once per registration):
 * - `getInjectedHTML`: everything resolved by shell time (blocked-inline
 *   values) — flushed with the shell.
 * - `onAsyncComponentResolved` → `preScript`: everything that arrived since
 *   the last flush, installed BEFORE the `$SIGX_REPLACE` call fires
 *   hydration listeners.
 * - `onStreamEnd`: final drain for registrations no later flush would carry
 *   (e.g. from a plugin's `getStreamingChunks` generator finishing last),
 *   emitted before the completion script.
 */

import type { SSRPlugin } from '../plugin';
import type { SSRContext } from './context';
import { asyncAssignmentJs, serializeAsyncScript } from './state';
import { getTypeHandlers, admitPayloadEntry } from './serialize';

const PLUGIN_NAME = 'sigx:state';

/**
 * Drain the dirty-set: collect every registered-but-unemitted key's value,
 * clearing the set (#279 discipline — O(flush), never a rescan of every
 * result per async resolution). Admission is the shared codec-aware check
 * (#420) — a `bigint`, a `Map`, or a handler-owned custom type is admitted
 * (the emitter tags it) instead of being dropped by a plain-JSON test.
 */
function drainUnflushed(ctx: SSRContext): Record<string, unknown> | null {
    const handlers = getTypeHandlers(ctx);
    let out: Record<string, unknown> | null = null;

    for (const key of ctx._unflushedAsyncKeys) {
        if (!ctx._asyncResults.has(key)) continue;
        const value = ctx._asyncResults.get(key);
        if (!admitPayloadEntry(key, value, 'useAsync', handlers)) continue;
        (out ??= {})[key] = value;
    }
    ctx._unflushedAsyncKeys.clear();

    return out;
}

export function stateSerializationPlugin(): SSRPlugin {
    return {
        name: PLUGIN_NAME,

        server: {
            getInjectedHTML(ctx) {
                const values = drainUnflushed(ctx);
                return values ? serializeAsyncScript(values, getTypeHandlers(ctx), ctx._nonce) : '';
            },

            onAsyncComponentResolved(_id, _html, ctx) {
                const values = drainUnflushed(ctx);
                if (!values) return;
                // preScript runs BEFORE $SIGX_REPLACE — the state must be
                // installed before the replace dispatches sigx:async-ready.
                return { preScript: asyncAssignmentJs(values, getTypeHandlers(ctx)) };
            },

            onStreamEnd(ctx) {
                const values = drainUnflushed(ctx);
                return values ? serializeAsyncScript(values, getTypeHandlers(ctx), ctx._nonce) : undefined;
            }
        }
    };
}
