/**
 * App-carried SSR plugins — the DI seam packs use to hand their server-side
 * render hooks to the SSR pipeline from `install(app)` (#413: `app.use(...)`
 * is the one install shape).
 *
 * `app.use(islandsPlugin())` provides the plugin from its `install(app)`;
 * every render method that receives the App (`ssr.render(app)`,
 * `renderDocument*`, the fetch handler's `app` option) merges the app's
 * plugins with the instance's. Mirrors the `provideHydrateDefaults` pattern:
 * a token plus a structurally-typed provide helper, no core option bags.
 * This module is deliberately DOM-free so `install(app)` can run in any
 * bundle.
 */

import { createToken, getProvided, setProvided } from 'sigx/internals';
import type { SSRPlugin } from '../plugin';

/**
 * DI token under which app-carried SSR plugins accumulate.
 * @internal
 */
export const SSR_PLUGINS_TOKEN = createToken<SSRPlugin[]>('sigx:ssrPlugins');

/**
 * Register an SSR plugin on an app context at install time. Accumulating —
 * install order is preserved, and order is the `resolveBoundary` consult
 * order (`app.use(islandsPlugin()).use(resumePlugin())` consults islands
 * first). A plugin whose `name` is already provided is ignored (first wins).
 *
 * ```ts
 * install(app) {
 *     provideSSRPlugin(app._context, this);
 * }
 * ```
 */
export function provideSSRPlugin(
    appContext: { provides: Map<symbol, unknown> },
    plugin: SSRPlugin
): void {
    const existing = getProvided(appContext.provides, SSR_PLUGINS_TOKEN);
    if (!existing) {
        setProvided(appContext.provides, SSR_PLUGINS_TOKEN, [plugin]);
    } else if (!existing.some(p => p.name === plugin.name)) {
        existing.push(plugin);
    } else if (__DEV__) {
        console.warn(
            `[sigx ssr] provideSSRPlugin: a plugin named "${plugin.name}" is ` +
            `already provided on this app — ignored (first install wins).`
        );
    }
}

/** Resolve the app-carried plugin list (empty without an app / provides). */
export function getSSRPlugins(
    appContext: { provides?: Map<symbol, unknown> } | null | undefined
): readonly SSRPlugin[] {
    return getProvided(appContext?.provides, SSR_PLUGINS_TOKEN) ?? [];
}
