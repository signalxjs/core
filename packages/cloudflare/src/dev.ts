/**
 * Dev binding proxies (rfc-deploy §4.6): `cloudflare({ devProxy: true })`
 * boots wrangler's `getPlatformProxy()` in the adapter's dev hook and
 * stashes it on the dev server; the user's server file passes it VISIBLY
 * into `createDevRequestHandler({ platform: getDevPlatform(vite) })` — the
 * composition never hides.
 */
import type { ViteDevServer } from 'vite';

/** Structural view of wrangler's getPlatformProxy result — wrangler stays an
 *  optional peer, so its types never enter this package's graph. */
export interface DevPlatform {
    env: unknown;
    cf: unknown;
    ctx: unknown;
    caches: unknown;
    dispose(): Promise<void>;
}

const DEV_PLATFORM = Symbol.for('sigx.cloudflare.devPlatform');

type ServerWithPlatform = ViteDevServer & { [DEV_PLATFORM]?: DevPlatform };

export function attachDevPlatform(server: ViteDevServer, proxy: DevPlatform): void {
    (server as ServerWithPlatform)[DEV_PLATFORM] = proxy;
    // The proxy boots a workerd process — dispose it with the dev server or
    // the process tree lingers.
    const close = server.close.bind(server);
    server.close = async () => {
        await proxy.dispose().catch(() => {});
        return close();
    };
}

/**
 * The `{ env, cf, ctx, caches }` proxy attached by `cloudflare({ devProxy:
 * true })` — pass it as `createDevRequestHandler`'s `platform` option.
 */
export function getDevPlatform(server: ViteDevServer): DevPlatform {
    const proxy = (server as ServerWithPlatform)[DEV_PLATFORM];
    if (!proxy) {
        throw new Error(
            `[sigx:cloudflare] no dev platform on this server - enable it with ` +
            `cloudflare({ devProxy: true }) in the sigx({ ssr: { adapter } }) config ` +
            `(and install wrangler as a dev dependency).`
        );
    }
    return proxy;
}
