/**
 * SSR type augmentations for runtime-core.
 *
 * Extends ComponentSetupContext with SSR-specific fields (`ssr`, `_serverState`, etc.).
 * Strategy-specific client hydration directive types are contributed by SSR plugins.
 */

/**
 * SSR helper object for async data loading.
 * Provides clean async data loading that works seamlessly across server and client.
 */
export interface SSRHelper {
    /**
     * Load async data during SSR. The callback runs on the server and is skipped
     * during client hydration (state is automatically restored from server).
     *
     * @example
     * ```tsx
     * export const UserCard = component(({ signal, props, ssr }) => {
     *     const state = signal({ user: null, loading: true });
     *
     *     ssr.load(async () => {
     *         state.user = await fetchUser(props.userId);
     *         state.loading = false;
     *     });
     *
     *     return () => state.loading
     *         ? <div>Loading...</div>
     *         : <div>{state.user.name}</div>;
     * });
     * ```
     */
    load(fn: () => Promise<void>): void;

    /**
     * Whether we're currently running on the server (SSR context).
     */
    readonly isServer: boolean;

    /**
     * Whether we're hydrating on the client with server state.
     */
    readonly isHydrating: boolean;
}

// Augment types in runtime-core for SSR support
declare module '@sigx/runtime-core' {
    // Extend ComponentSetupContext with SSR-specific fields
    interface ComponentSetupContext {
        /**
         * SSR helper for async data loading.
         * Use `ssr.load()` to fetch data that runs on server and is skipped on client hydration.
         */
        ssr: SSRHelper;

        /**
         * @internal Map of signal names to their current values (for SSR state capture)
         */
        _signals?: Map<string, any>;

        /**
         * @internal Pre-captured server state (for client hydration restoration)
         */
        _serverState?: Record<string, any>;

        /**
         * @internal Array of pending SSR load promises
         */
        _ssrLoads?: Promise<void>[];
    }
}
