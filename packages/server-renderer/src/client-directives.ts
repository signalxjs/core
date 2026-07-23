/**
 * SSR type augmentations for runtime-core.
 *
 * Extends ComponentSetupContext with SSR-specific fields (`ssr`, `_ssrLoads`).
 * Strategy-specific client hydration directive types are contributed by SSR plugins.
 */

import type { SSRContext } from './server/context';

/**
 * SSR environment flags exposed as `ctx.ssr`.
 * Data loading lives in the useAsync/useStream composables (runtime-core),
 * which server renderers override per environment — see docs/rfc-use-async.md.
 */
export interface SSRHelper {
    /**
     * Whether we're currently running on the server (SSR context).
     */
    readonly isServer: boolean;

    /**
     * Whether we're hydrating server-rendered DOM on the client.
     */
    readonly isHydrating: boolean;

    /**
     * The per-request render context — the supported access point for packs
     * that need it from inside a component setup (#407): `useResponse` and
     * `useHead` read through it, and request-state owners reach
     * `registerSerializedState` this way. Present only during a server
     * render (`isServer` true); never set on client-side `ssr` objects.
     */
    readonly _ctx?: SSRContext;
}

// Augment types in runtime-core for SSR support
declare module '@sigx/runtime-core' {
    // Extend ComponentSetupContext with SSR-specific fields
    interface ComponentSetupContext {
        /**
         * SSR environment flags (`isServer` / `isHydrating`).
         * Async data loading lives in `useAsync()`/`useStream()` (runtime-core).
         */
        ssr: SSRHelper;

        /**
         * @internal Array of pending SSR load promises
         */
        _ssrLoads?: Promise<void>[];
    }
}
