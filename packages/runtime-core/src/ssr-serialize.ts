/**
 * SSR serializer type-handler seam — the per-app registry packs use to teach
 * the server renderer's state/boundary serialization about non-JSON types
 * (Date, Map, custom classes, …).
 *
 * This file is deliberately SSR-free (a token and a Map write) and lives in
 * runtime-core so packs can register from `install(app)` in client bundles
 * without importing `@sigx/server-renderer`. Mirrors the async engine seam
 * (`ASYNC_ENGINE_TOKEN` / `provideAsyncEngine`).
 *
 * Phase 1 covers the serialize side only; the client revive side ships with
 * the cache-seed work (rfc-async §7).
 */

import { createToken, getProvided, setProvided } from './di/token.js';

/** One pluggable serializer for a non-JSON-representable type. */
export interface SSRTypeHandler {
    /** Identifies the handler (dev warnings, dedupe by consumers). */
    name: string;
    /** Whether this handler owns the value. Receives the RAW value (before any toJSON). */
    test(value: unknown): boolean;
    /** Return a JSON-safe representation — the handler owns its encoding (e.g. `{ $date: n }`). */
    serialize(value: unknown): unknown;
}

/**
 * DI token under which serializer handlers are provided at app level.
 * @internal
 */
export const SSR_SERIALIZER_TOKEN = createToken<SSRTypeHandler[]>('sigx:ssrSerializer');

/**
 * Append serializer handlers on an app context at install time.
 *
 * Accumulating: multiple packs can each contribute handlers; earlier-installed
 * handlers are consulted first. The parameter is structurally typed so packs
 * don't need the AppContext type:
 *
 * ```ts
 * install(app) {
 *     provideSSRSerializerHandlers(app._context, [dateHandler]);
 * }
 * ```
 */
export function provideSSRSerializerHandlers(
    appContext: { provides: Map<symbol, unknown> },
    handlers: SSRTypeHandler[]
): void {
    const existing = getProvided(appContext.provides, SSR_SERIALIZER_TOKEN);
    setProvided(
        appContext.provides,
        SSR_SERIALIZER_TOKEN,
        existing ? [...existing, ...handlers] : [...handlers]
    );
}
