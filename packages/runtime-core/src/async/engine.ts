/**
 * The client async-engine seam (docs/rfc-async.md §7, obligation 1).
 *
 * A pack (e.g. @sigx/cache) swaps the engine PER APP: it provides an
 * AsyncEngine under the DI token at install (`app.use(cachePlugin())`), and
 * `useData`/`useAction` resolve it through the instance parent chain — the
 * same walk every other provided value uses. No pack ⇒ the default engine
 * (core's async cell). The SSR per-instance `_useAsync` provider takes
 * precedence over any engine, so server rendering is unaffected.
 *
 * The engine receives the WHOLE options bag untouched (open AsyncOptions /
 * ActionOptions interfaces — §7 obligation 2) and core's key machinery stays
 * in front: getters, canonical-JSON tuple identity, and dev guards run in
 * core; the engine sees only resolved canonical keys via `setKey`.
 */

import type { ComponentSetupContext } from '../component-types.js';
import type { AsyncFetcherContext, AsyncState } from './shared.js';
import { createDataCell } from './cell.js';
import { createToken, setProvided } from '../di/token.js';

/**
 * One read call site: a stable state object plus the key feed. `setKey` is
 * invoked once for a static key and per canonical change for a getter key
 * (`null` = skip ⇒ 'idle'). `raw` is the resolved key value — the fetcher's
 * first argument.
 *
 * @internal — the §7 pack contract surface.
 */
export interface AsyncReadHandle<T> {
    state: AsyncState<T>;
    setKey(canon: string | null, raw: unknown): void;
    dispose(): void;
}

/** @internal — the §7 pack contract surface. */
export interface AsyncEngine {
    /**
     * Create the cell for one `useData` call. `options` is the whole bag;
     * `instance` is the owning setup context (unmount hooks, error bubbling).
     */
    read<T>(
        fetcher: (arg: unknown, ctx: AsyncFetcherContext) => Promise<T>,
        options: object,
        instance: ComponentSetupContext<any, any, any>
    ): AsyncReadHandle<T>;

    /**
     * Optionally wrap a `useAction` result (optimistic apply, cache-aware
     * invalidation). Receives the fully-built action; returns what the
     * caller gets.
     */
    wrapAction?<A>(action: A, options: object, instance: ComponentSetupContext<any, any, any>): A;
}

/** DI token under which a pack provides its engine (app-level provide). @internal */
export const ASYNC_ENGINE_TOKEN = createToken<AsyncEngine>('sigx:asyncEngine');

/**
 * Register an engine on an app context (called by packs at install time).
 * Sugar over `appContext.provides` so packs don't depend on the token.
 *
 * @internal — the §7 pack contract surface.
 */
export function provideAsyncEngine(
    appContext: { provides: Map<symbol, unknown> },
    engine: AsyncEngine
): void {
    setProvided(appContext.provides, ASYNC_ENGINE_TOKEN, engine);
}

/**
 * The default engine — core's async cell (in-flight dedupe, SSR-blob
 * restore/writeback, pinned key-change/refresh semantics). Exported through
 * internals so a pack can DELEGATE reads it has no policy for, instead of
 * re-implementing core semantics.
 *
 * @internal — the §7 pack contract surface.
 */
export const defaultAsyncEngine: AsyncEngine = {
    read(fetcher, _options, instance) {
        const handle = createDataCell(fetcher, instance);
        return {
            state: handle.cell,
            setKey: handle.setKey,
            dispose: handle.dispose,
        };
    },
};
