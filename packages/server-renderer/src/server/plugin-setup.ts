/**
 * Merge + setup for SSR plugins from both sources: instance plugins
 * (`createSSR({ plugins })` — engine/advanced use) and app-carried plugins
 * (`app.use(pack())` → `provideSSRPlugin`, the public install path). One
 * implementation shared by the render paths, the document engine, and
 * `@sigx/resume`'s boundary refresh.
 */

import type { SSRPlugin } from '../plugin';
import type { SSRContext } from './context';
import { getSSRPlugins } from '../client/ssr-plugins';

/**
 * `[...instancePlugins, ...appCarried]`, deduped by `name` — the first
 * occurrence wins (`__DEV__` warns when an app-carried plugin collides with
 * an instance plugin of the same name). App-carried order is `app.use()`
 * order, so plugin consult order stays an app decision.
 */
export function mergeSSRPlugins(
    instancePlugins: readonly SSRPlugin[],
    appContext: { provides?: Map<symbol, unknown> } | null | undefined
): SSRPlugin[] {
    const merged: SSRPlugin[] = [...instancePlugins];
    for (const plugin of getSSRPlugins(appContext)) {
        if (merged.some(p => p.name === plugin.name)) {
            if (__DEV__) {
                console.warn(
                    `[sigx ssr] app-carried plugin "${plugin.name}" collides with an ` +
                    `instance plugin of the same name — the instance plugin wins.`
                );
            }
            continue;
        }
        merged.push(plugin);
    }
    return merged;
}

/**
 * Attach a resolved plugin set to a context and run the server `setup`
 * hooks. Call AFTER `ctx._appContext` is assigned — setup hooks may read it.
 */
export function initPluginContext(ctx: SSRContext, plugins: readonly SSRPlugin[]): void {
    ctx._plugins = plugins as SSRPlugin[];
    for (const plugin of plugins) {
        plugin.server?.setup?.(ctx);
    }
}
