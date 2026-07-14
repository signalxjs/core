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

import type { Plugin } from 'sigx';
import { provideAsyncEngine, registerHandledAsyncOptionKeys } from 'sigx/internals';
import { CacheStore } from './store.js';
import { createCacheEngine } from './engine.js';
import type { CacheDefaults } from './options.js';

export type { CacheOptions, CacheActionOptions, CacheDefaults } from './options.js';
export type { CachedAsyncState } from './engine.js';

// ─── §7 obligation 2: the pack's options exist exactly when it's installed ──

declare module 'sigx' {
    interface AsyncOptions {
        /** Cache policy for this read — provided by @sigx/cache (app.use(cachePlugin())). */
        cache?: import('./options.js').CacheOptions;
    }
    interface ActionOptions {
        /** Cache effects for this action — provided by @sigx/cache (app.use(cachePlugin())). */
        cache?: import('./options.js').CacheActionOptions;
    }
    interface AsyncState<T> {
        /**
         * Drop this key's cached value and refetch (all mounted consumers
         * update). Present on every read once @sigx/cache is installed.
         */
        invalidate?(): void;
        /**
         * Optimistic write-through to this key's cached value. Present on
         * reads served WITH a `cache` option. Loosely typed here so the
         * augmentation stays variance-neutral for AsyncState<T> generally —
         * `CachedAsyncState<T>` (exported by this pack) is the precisely
         * typed view.
         */
        mutate?(update: unknown): void;
    }
}

/**
 * Install the cache engine on an app (one store per app). Reads/actions
 * opt in per call site via the `cache` option; reads without it keep
 * core's default-engine semantics verbatim.
 */
export function cachePlugin(defaults?: CacheDefaults): Plugin {
    return {
        name: 'sigx:cache',
        install(app) {
            const store = new CacheStore(defaults);
            provideAsyncEngine(app._context, createCacheEngine(store));
            // Silence core's unknown-option dev warning for our key.
            registerHandledAsyncOptionKeys('cache');
            // Timers and focus listeners die with the app.
            app._context.disposables.add(() => store.destroy());
        },
    };
}
