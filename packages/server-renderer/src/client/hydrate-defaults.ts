/**
 * Per-app hydration defaults — the DI seam packs use to declare how an app
 * hydrates (rfc-ssr-platform §1.2, open question 5 resolved as
 * plugin-provided).
 *
 * `app.use(islandsPlugin())` provides `{ boundaries: 'explicit' }` from its
 * `install(app)`; `app.hydrate(container)` reads the default. No provide =
 * the root walk ('auto'). Mirrors the `provideAsyncEngine` pattern: a token
 * plus a structurally-typed provide helper, no core option bags. This module
 * is deliberately DOM-free so `install(app)` can run in any bundle.
 */

import { createToken, getProvided, setProvided } from 'sigx/internals';

export interface HydrateDefaults {
    /**
     * 'auto' (default): the root walk hydrates everything; boundary-table
     * entries with a deferred strategy are intercepted and scheduled.
     * 'explicit': no root walk — ONLY boundary-table entries hydrate (the
     * islands app default; the root boundary is `hydrate: 'never'`).
     */
    boundaries?: 'auto' | 'explicit';
}

/**
 * DI token under which hydration defaults are provided at app level.
 * @internal
 */
export const HYDRATE_DEFAULTS_TOKEN = createToken<HydrateDefaults>('sigx:hydrateDefaults');

/**
 * Declare hydration defaults on an app context at install time. Later
 * provides merge over earlier ones (last plugin wins per field).
 *
 * ```ts
 * install(app) {
 *     provideHydrateDefaults(app._context, { boundaries: 'explicit' });
 * }
 * ```
 */
export function provideHydrateDefaults(
    appContext: { provides: Map<symbol, unknown> },
    defaults: HydrateDefaults
): void {
    const existing = getProvided(appContext.provides, HYDRATE_DEFAULTS_TOKEN);
    setProvided(appContext.provides, HYDRATE_DEFAULTS_TOKEN, { ...existing, ...defaults });
}

/** Resolve the provided defaults off an app context (empty without one). */
export function getHydrateDefaults(
    appContext: { provides: Map<symbol, unknown> } | null | undefined
): HydrateDefaults {
    return getProvided(appContext?.provides, HYDRATE_DEFAULTS_TOKEN) ?? {};
}
