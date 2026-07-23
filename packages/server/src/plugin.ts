/**
 * The app-plugin face of @sigx/server (#413) — `app.use(serverPlugin({...}))`
 * is how an app configures its server-function CLIENT side: the stub
 * transport and the custom-type vocabulary.
 *
 * This entry is the only part of the package that imports the sigx runtime
 * (`provideTypeHandlers` needs runtime-core's token machinery), which is why
 * it is a separate `@sigx/server/plugin` export: `@sigx/server/client` — the
 * dependency-free stub entry the transform emits imports of — stays
 * import-free by contract.
 *
 * The `types` option is the one-registration story for custom types (#411):
 * a single `serverPlugin({ types })` covers BOTH serialization vocabularies —
 * the RPC wire (`__SIGX_SERVERFN_CODEC__`, read by every stub and by the
 * endpoint) and the state/boundary registry (`provideTypeHandlers`: the DI
 * token the server render reads, mirrored to `__SIGX_TYPE_HANDLERS__` on the
 * browser for the client decode paths).
 *
 * @example
 * ```ts
 * app.use(serverPlugin({
 *     transport: { endpoint: 'https://api.example.com/_sigx/fn' },
 *     types: [moneyHandler],
 * }));
 * ```
 */

import type { App, Plugin } from 'sigx';
import { provideTypeHandlers } from 'sigx/internals';
import type { TypeHandler } from '@sigx/serialize';
import { configureServerFn, type ServerFnTransport } from './client/index.js';

// The transport type belongs with the option that takes it — authoring a
// `serverPlugin({ transport })` must not require importing from the stubs
// entry (#437).
export type { ServerFnTransport } from './client/index.js';

/**
 * Stamp handlers onto the RPC wire codec global (`__SIGX_SERVERFN_CODEC__`,
 * read at call time by `encodeWire`/`reviveWire` on both sides). Tag-keyed:
 * a handler whose `tag` is already registered REPLACES the previous one, so
 * repeated registration (a per-request server app installing the same
 * plugin) is idempotent. Tag-less handlers are appended once by identity —
 * define those as module-level constants, not fresh objects per call.
 *
 * Standalone export for app-less contexts (an endpoint-only process, a
 * zero-JS loader page); `serverPlugin({ types })` calls it for you.
 */
export function registerWireTypeHandlers(handlers: TypeHandler[]): void {
    const g = globalThis as { __SIGX_SERVERFN_CODEC__?: TypeHandler[] };
    const next = Array.isArray(g.__SIGX_SERVERFN_CODEC__)
        ? g.__SIGX_SERVERFN_CODEC__.slice()
        : [];
    for (const handler of handlers) {
        const at = handler.tag
            ? next.findIndex(h => h.tag === handler.tag)
            : next.indexOf(handler);
        if (at >= 0) next[at] = handler;
        else next.push(handler);
    }
    g.__SIGX_SERVERFN_CODEC__ = next;
}

export interface ServerPluginOptions {
    /**
     * Stub transport (endpoint / headers / fetch) — resolved at call time by
     * every stub. The transport is a MODULE-LEVEL seam (stubs are
     * dependency-free and cannot read app DI), so on a page with several
     * apps the last installed transport wins; `app.unmount()` clears it only
     * if it is still the active one. Mixing this with direct
     * `configureServerFn` calls is unsupported — pick one.
     *
     * Installed on LIVE CLIENTS only (browser, or a native client that has
     * called `declareLiveClient()`): a per-request SERVER app's install
     * silently skips it — in-process SSR-time calls never ride the stub
     * transport, and a per-request write to a process-global seam would
     * bleed across concurrent requests. One `serverPlugin` in a shared
     * `createApp` therefore does the right thing on both sides.
     */
    transport?: ServerFnTransport;
    /**
     * Custom type handlers, registered ONCE for every boundary (#411): the
     * RPC wire (arguments, results, stream chunks, `ServerFnError.data`) AND
     * the SSR state blob / boundary table / refresh / cache seed.
     */
    types?: TypeHandler[];
}

// The transport this module last installed — dispose compares against it so
// unmounting an old app never clobbers a successor app's transport.
let installedTransport: ServerFnTransport | null = null;

/**
 * The @sigx/server pack as an app plugin — client/transport-side
 * configuration. Install with `app.use(serverPlugin({ ... }))`.
 */
export function serverPlugin(options: ServerPluginOptions = {}): Plugin {
    return {
        name: 'sigx:server',

        install(app: App) {
            // Live-client detection: the browser, or a native client (lynx,
            // terminal) that declared itself via the __SIGX_LIVE_CLIENT__
            // seam. A per-request SERVER app must not touch the
            // process-global transport (cross-request bleed); in-process
            // SSR-time calls never use it anyway.
            const isLiveClient =
                typeof document !== 'undefined' ||
                (globalThis as { __SIGX_LIVE_CLIENT__?: boolean }).__SIGX_LIVE_CLIENT__ === true;
            if (options.transport && isLiveClient) {
                if (__DEV__ && installedTransport && installedTransport !== options.transport) {
                    console.warn(
                        '[sigx server] serverPlugin: overwriting a live server-fn transport ' +
                        'installed by another app — the transport seam is page-global, last ' +
                        'install wins.'
                    );
                }
                const transport = options.transport;
                installedTransport = transport;
                configureServerFn(transport);
                app._context.disposables.add(() => {
                    if (installedTransport === transport) {
                        installedTransport = null;
                        configureServerFn(null);
                    }
                });
            }
            if (options.types && options.types.length > 0) {
                provideTypeHandlers(app._context, options.types);
                registerWireTypeHandlers(options.types);
            }
        }
    };
}
