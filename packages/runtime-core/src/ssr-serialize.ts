/**
 * Serializer DI glue — the per-app registry packs use to teach the boundary
 * codec about their own types (a domain class, a branded value, …).
 *
 * The codec ITSELF lives in `@sigx/serialize`: it is used on both sides of
 * every boundary and by packs that must never depend on the renderer or the
 * RPC layer, so it is not a runtime-core concern. What stays here is only the
 * part that genuinely needs runtime-core — `createToken` and the app context.
 *
 * Deliberately SSR-free (a token and a Map write) so packs can register from
 * `install(app)` in client bundles without importing `@sigx/server-renderer`.
 * Mirrors the async engine seam (`ASYNC_ENGINE_TOKEN` / `provideAsyncEngine`).
 */

import type { TypeHandler } from '@sigx/serialize';
import { createToken, getProvided, setProvided } from './di/token.js';

/**
 * DI token under which type handlers are provided at app level.
 * @internal
 */
export const TYPE_HANDLER_TOKEN = createToken<TypeHandler[]>('sigx:typeHandlers');

/**
 * Append type handlers on an app context at install time.
 *
 * Accumulating: multiple packs can each contribute handlers; earlier-installed
 * handlers are consulted first, and all of them before `@sigx/serialize`'s
 * built-in vocabulary — so a pack can own a type the built-ins also cover. The
 * parameter is structurally typed so packs don't need the AppContext type:
 *
 * ```ts
 * install(app) {
 *     provideTypeHandlers(app._context, [{
 *         name: 'money', tag: '$money',
 *         test: (v) => v instanceof Money,
 *         serialize: (v) => (v as Money).cents,
 *         revive: (c) => new Money(c as number),
 *     }]);
 * }
 * ```
 */
export function provideTypeHandlers(
    appContext: { provides: Map<symbol, unknown> },
    handlers: TypeHandler[]
): void {
    const existing = getProvided(appContext.provides, TYPE_HANDLER_TOKEN);
    setProvided(
        appContext.provides,
        TYPE_HANDLER_TOKEN,
        existing ? [...existing, ...handlers] : [...handlers]
    );
}
