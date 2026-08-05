/**
 * @sigx/cache — cache POLICY for SignalX's value-first async, riding the
 * rfc-async §7 pack contract. Core stays mechanism-only; installing this
 * pack changes one line, not the call sites:
 *
 *   import { cachePlugin } from '@sigx/cache';
 *   app.use(cachePlugin({ staleTime: 30_000 }));
 *
 *   const user = useData('user', fetchUser, {
 *       cache: { staleTime: 60_000, revalidateOnFocus: true },  // typed by this pack's augmentation
 *   });
 *   user.invalidate();                    // drop entry + refetch everywhere
 *   user.mutate(u => ({ ...u, name }));   // optimistic write-through
 *
 *   const save = useAction(saveUser, {
 *       cache: { invalidates: [['users']], optimistic: { key: 'user', apply: (u, next) => next } },
 *   });
 *
 * SSR: the pack adopts the page's `__SIGX_ASYNC__` hydration blob as its
 * initial cache state (§7 blob-as-seed) — server-fetched values hydrate as
 * fresh entries, nothing refetches on load, and the server render itself is
 * untouched (the SSR provider seam takes precedence over any engine).
 */

import type { Plugin } from '@sigx/runtime-core';
import { provideAsyncEngine, registerHandledAsyncOptionKeys } from '@sigx/runtime-core/internals';
import { CacheStore } from './store.js';
import { createCacheEngine } from './engine.js';
import type { CacheDefaults } from './options.js';

export type { CacheOptions, CacheActionOptions, CacheDefaults } from './options.js';
export type { CachedAsyncState } from './engine.js';

// ─── §7 obligation 2: the pack's options exist exactly when it's installed ──
// Augment the DECLARING module (@sigx/runtime-core) — the merge reaches
// `sigx` consumers through its `export *`, and stays valid for non-web
// renderers that never install the umbrella.

declare module '@sigx/runtime-core' {
    interface AsyncOptions {
        /** Cache policy for this read — provided by @sigx/cache (app.use(cachePlugin())). */
        cache?: import('./options.js').CacheOptions;
    }
    interface ActionOptions {
        /** Cache effects for this action — provided by @sigx/cache (app.use(cachePlugin())). */
        cache?: import('./options.js').CacheActionOptions;
    }
    // `AsyncState<T>` itself is a union (not augmentable); `AsyncStateBase`
    // is the interface every member carries, so augmenting it lands these on
    // every member — and therefore on every `AsyncState<T>` read.
    interface AsyncStateBase<T> {
        /**
         * Drop this key's cached value and refetch (all mounted consumers
         * update). Present on every read once @sigx/cache is installed.
         */
        invalidate?(): void;
        /**
         * Optimistic write-through to this key's cached value. Present on
         * reads served WITH a `cache` option — `CachedAsyncState<T>` is the
         * view where it is non-optional. Same signature as there: the base is
         * generic, so the augmentation can be precisely typed (method-syntax
         * bivariance keeps AsyncState<T> assignability unaffected).
         */
        mutate?(update: T | ((current: T | null) => T)): void;
    }
}

/**
 * Install the cache engine on an app (one store per app). Reads/actions
 * opt in per call site via the `cache` option; reads without it keep
 * core's default-engine semantics verbatim.
 */
/**
 * The `__SIGX_SERVERFN_CACHE__` seam's shape at this (consuming) end. Must
 * match the stamping end's `ServerFnCacheDirectives` in
 * `@sigx/server/client` — the two cannot share an import (the seam exists
 * precisely so neither pack depends on the other); `docs/seams.md` carries
 * the canonical contract both copy.
 */
type ServerFnCacheSeam = {
    __SIGX_SERVERFN_CACHE__?: (directives: {
        invalidates?: ReadonlyArray<string | readonly unknown[]>;
    }) => void;
};

export function cachePlugin(defaults?: CacheDefaults): Plugin {
    return {
        name: 'sigx:cache',
        install(app) {
            const store = new CacheStore(defaults);
            provideAsyncEngine(app._context, createCacheEngine(store));
            // Silence core's unknown-option dev warning for our key.
            registerHandledAsyncOptionKeys('cache');
            // Server-declared invalidation (rfc-server §6.2): @sigx/server's
            // fn stubs surface the envelope's `$cache` through this global
            // seam — a global, not an import in either direction (the
            // live-client-marker pattern), so neither pack depends on the
            // other. Each pattern goes straight to `invalidate()` — the
            // server declared it where the data changed. One live client =
            // one app; a later install supersedes an earlier one, and
            // disposal only removes its OWN handler.
            const seam = globalThis as ServerFnCacheSeam;
            const onDirectives: NonNullable<typeof seam.__SIGX_SERVERFN_CACHE__> = (
                directives
            ) => {
                for (const pattern of directives.invalidates ?? []) {
                    // Isolate per pattern: wire patterns are JSON-safe by
                    // construction, but the seam is a global — one bad
                    // pattern from another caller must not starve the rest.
                    try {
                        store.invalidate(pattern);
                    } catch (error) {
                        if (__DEV__) {
                            console.error('[sigx cache] $cache pattern failed to invalidate:', pattern, error);
                        }
                    }
                }
            };
            // `defineProperty` so the seam lands NON-ENUMERABLE (the default
            // for a new property defined this way) — pack-to-pack wiring is
            // not a page payload and does not belong in
            // `Object.keys(globalThis)`. `configurable` keeps the disposal
            // `delete` below working.
            Object.defineProperty(seam, '__SIGX_SERVERFN_CACHE__', {
                value: onDirectives,
                writable: true,
                configurable: true
            });
            app._context.disposables.add(() => {
                if (seam.__SIGX_SERVERFN_CACHE__ === onDirectives) {
                    delete seam.__SIGX_SERVERFN_CACHE__;
                }
            });
            // Timers and focus listeners die with the app.
            app._context.disposables.add(() => store.destroy());
        },
    };
}
