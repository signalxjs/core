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
 *     provideTypeHandlers(app._context, [defineTypeHandler({
 *         name: 'money', tag: '$money',
 *         test: (v): v is Money => v instanceof Money,
 *         serialize: (m) => m.cents,           // m: Money
 *         revive: (cents) => new Money(cents), // cents: number
 *     })]);
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

    // Mirror onto the page-global seam (`docs/seams.md`) so the CLIENT read
    // paths can decode these types too. They have no app context to resolve:
    // `peekRestored` runs inside a reactive effect, and the boundary readers
    // live in packs with no instance in scope. The blob is itself a page
    // global, so a page-global decoder matches its scope exactly.
    //
    // Browser only — on the server the DI token is authoritative, and a
    // process-wide list would let two apps' handlers collide across requests.
    if (typeof window === 'undefined') return;
    const g = globalThis as { __SIGX_TYPE_HANDLERS__?: TypeHandler[] };
    // `defineProperty`, not assignment: the seam is pack-internal wiring, so
    // it stays NON-ENUMERABLE — out of `Object.keys(globalThis)` and devtools
    // completion. Unlike `__SIGX_ASYNC__`/`__SIGX_BOUNDARIES__`, nothing emits
    // this into HTML, so there is no wire byte to keep identical. A third
    // party that assigns the name directly still works and inherits the
    // descriptor.
    //
    // `enumerable` is spelled even though `false` is the default for a NEW
    // property: a pack — or an older copy of this module under dev HMR — may
    // have created it by plain assignment, and a partial descriptor would
    // preserve that property's `enumerable: true`.
    Object.defineProperty(g, '__SIGX_TYPE_HANDLERS__', {
        value: [...(g.__SIGX_TYPE_HANDLERS__ ?? []), ...handlers],
        writable: true,
        configurable: true,
        enumerable: false
    });
}
