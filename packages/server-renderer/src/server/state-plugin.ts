/**
 * Built-in state serialization plugin.
 *
 * Ships the values resolved by useAsync/useStream to the client as
 * `window.__SIGX_ASYNC__`, keyed by the calls' explicit keys. The client
 * composables consume the blob on first use, so fetchers don't re-run after
 * hydration — no duplicate requests, no flicker.
 *
 * Opt-in: `createSSR().use(stateSerializationPlugin())`. The `renderDocument`
 * API enables it by default.
 *
 * Emission points:
 * - `getInjectedHTML`: everything resolved by shell time (blocked-inline
 *   values) — flushed with the shell.
 * - `onAsyncComponentResolved` → `preScript`: per-component keys for
 *   streamed components, installed BEFORE the `$SIGX_REPLACE` call fires
 *   hydration listeners.
 */

import type { SSRPlugin } from '../plugin';
import type { SSRContext } from './context';
import { asyncAssignmentJs, serializeAsyncScript, isSerializable } from './state';
import { getTypeHandlers } from './serialize';

const PLUGIN_NAME = 'sigx:state';

interface StateData {
    emitted: Set<string>;
}

function takeUnemitted(
    ctx: SSRContext,
    emitted: Set<string>,
    keys: string[] | null
): Record<string, unknown> | null {
    const source = keys ?? [...ctx._asyncResults.keys()];
    let out: Record<string, unknown> | null = null;

    for (const key of source) {
        if (emitted.has(key) || !ctx._asyncResults.has(key)) continue;
        const value = ctx._asyncResults.get(key);
        emitted.add(key);
        if (!isSerializable(key, value)) continue;
        (out ??= {})[key] = value;
    }

    return out;
}

export function stateSerializationPlugin(): SSRPlugin {
    return {
        name: PLUGIN_NAME,

        server: {
            setup(ctx) {
                ctx.setPluginData<StateData>(PLUGIN_NAME, { emitted: new Set() });
            },

            getInjectedHTML(ctx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                const values = takeUnemitted(ctx, data.emitted, null);
                return values ? serializeAsyncScript(values, getTypeHandlers(ctx)) : '';
            },

            onAsyncComponentResolved(id, _html, ctx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                const keys = ctx._asyncKeysByComponent.get(id);
                if (!keys) return;
                const values = takeUnemitted(ctx, data.emitted, keys);
                if (!values) return;
                // preScript runs BEFORE $SIGX_REPLACE — the state must be
                // installed before the replace dispatches sigx:async-ready.
                return { preScript: asyncAssignmentJs(values, getTypeHandlers(ctx)) };
            }
        }
    };
}
