/**
 * Merge + setup for SSR plugins from both sources: instance plugins
 * (`createSSR({ plugins })` — engine/advanced use) and app-carried plugins
 * (`app.use(pack())` → `provideSSRPlugin`, the public install path). One
 * implementation shared by the render paths, the document engine, and
 * `@sigx/resume`'s boundary refresh.
 */

import type { SSRPlugin } from '../plugin';
import type { SSRContext } from './context';
import { getSSRPlugins, SSR_PLUGINS_TOKEN } from '../client/ssr-plugins';
import { hasForeignToken } from 'sigx/internals';

/**
 * The app installed packs, but through a DIFFERENT copy of this package —
 * so the plugins it provided are keyed by a token this copy will never
 * match, and the render silently proceeds with none of them: no
 * `resolveBoundary`, no boundary table, no pack behaviour whatsoever. Every
 * app-carried seam (`provideHydrateDefaults`, `provideTypeHandlers`) is
 * broken by the same cause, so one warning covers the app.
 *
 * Dev-only, and it fires only on a provides key carrying our token's
 * description that is not our token — which, given `sigx:ssrPlugins` is
 * minted in exactly one place, means something other than this copy of the
 * package wrote it. An app that simply installed no packs has no such key
 * and says nothing.
 */
function warnForeignPluginToken(
    appContext: { provides?: Map<symbol, unknown> } | null | undefined
): void {
    if (!hasForeignToken(appContext?.provides, SSR_PLUGINS_TOKEN)) return;
    console.warn(
        `[sigx ssr] this app installed SSR plugins through a SECOND copy of ` +
        `@sigx/server-renderer — they are invisible to the renderer, so this ` +
        `render has no pack plugins at all (no boundary table, no islands or ` +
        `resume behaviour). DI identity is per module graph by design, so two ` +
        `copies never see each other's provides. Make @sigx/* resolve once: ` +
        `check ssr.noExternal / resolve.dedupe in your bundler, that a dev ` +
        `server loads the renderer from the same graph as the app, and that ` +
        `only one version of the family is installed.`
    );
}

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
    if (__DEV__) warnForeignPluginToken(appContext);
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
