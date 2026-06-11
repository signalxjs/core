/**
 * Built-in state serialization plugin.
 *
 * Captures the signal state of components that fetch data via `ssr.load()`
 * and ships it to the client as `window.__SIGX_STATE__`, keyed by component
 * ID. The hydration walk picks the blob up automatically (see
 * client/hydrate-component.ts), turning `ssr.load()` into a no-op on the
 * client — no duplicate fetch, no flicker.
 *
 * Opt-in: `createSSR().use(stateSerializationPlugin())`. The `renderDocument`
 * API enables it by default. Implemented entirely on the public SSRPlugin
 * surface — it is also the reference plugin for custom state strategies.
 *
 * Notes:
 * - Only components with `ssr.load()` calls are captured (components without
 *   loads re-run their setup deterministically on the client and need no
 *   state transfer).
 * - Components a plugin handled with `mode: 'skip'` are still captured if
 *   they registered loads; skip-mode plugins that manage their own state
 *   should order themselves before this plugin and clear the context.
 */

import type { SSRPlugin } from '../plugin';
import {
    createTrackingSignal,
    captureSignalState,
    serializeStateScript,
    stateAssignmentJs,
    type TrackedSignalStore
} from './state';

const PLUGIN_NAME = 'sigx:state';

interface StateData {
    /** componentId → tracked signals for that component */
    stores: Map<number, TrackedSignalStore>;
    /** componentId → ssrLoads array ref (length read after render) */
    loads: Map<number, Promise<void>[]>;
    /** componentId → component name (for dev warnings) */
    names: Map<number, string>;
    /** accumulated captures for inline (blocked) components */
    captured: Record<number, Record<string, any>>;
}

export function stateSerializationPlugin(): SSRPlugin {
    return {
        name: PLUGIN_NAME,

        server: {
            setup(ctx) {
                ctx.setPluginData<StateData>(PLUGIN_NAME, {
                    stores: new Map(),
                    loads: new Map(),
                    names: new Map(),
                    captured: {}
                });
            },

            transformComponentContext(ctx, vnode, componentCtx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                // The component's ID was pushed onto the stack just before
                // this hook runs.
                const id = ctx._componentStack[ctx._componentStack.length - 1];

                const store: TrackedSignalStore = new Map();
                data.stores.set(id, store);
                if (componentCtx._ssrLoads) data.loads.set(id, componentCtx._ssrLoads);
                data.names.set(id, (vnode.type as any).__name || 'Anonymous');

                componentCtx.signal = createTrackingSignal(store) as any;
                return componentCtx;
            },

            afterRenderComponent(id, _vnode, _html, ctx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                const loads = data.loads.get(id);
                if (!loads || loads.length === 0) return; // no ssr.load() — nothing to transfer

                // Streamed components are captured later, in
                // onAsyncComponentResolved, once their loads have resolved.
                for (const pending of ctx._pendingAsync) {
                    if (pending.id === id) return;
                }

                // Blocked inline: loads have resolved, signals hold final values.
                const store = data.stores.get(id);
                const state = store && captureSignalState(store, data.names.get(id) || 'Anonymous');
                if (state) data.captured[id] = state;
            },

            onAsyncComponentResolved(id, _html, ctx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                const store = data.stores.get(id);
                if (!store) return;

                const state = captureSignalState(store, data.names.get(id) || 'Anonymous');
                if (!state) return;

                // preScript runs BEFORE $SIGX_REPLACE — the state must be
                // installed before the replace dispatches sigx:async-ready
                // and hydration listeners fire.
                return { preScript: stateAssignmentJs({ [id]: state }) };
            },

            getInjectedHTML(ctx) {
                const data = ctx.getPluginData<StateData>(PLUGIN_NAME)!;
                if (Object.keys(data.captured).length === 0) return '';
                return serializeStateScript(data.captured);
            }
        }
    };
}
