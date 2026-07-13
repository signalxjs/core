/**
 * useData — THE keyed async read (docs/rfc-async.md rev 8).
 *
 * Every read has a key — data always has identity:
 *
 *   useData(key, fn)                  → static key: SSR-transferable
 *   useData(() => key, fn)            → reactive key: string OR tuple; falsy ⇒ idle
 *   useData(key, fn, {server:false})  → client-only (still keyed — there is
 *                                       NO bare-fetcher form)
 *
 * The key does three jobs: reactive trigger, cache/SSR identity, fetcher
 * input. The fetcher runs UNTRACKED — only the key getter is reactive; a
 * parameter that should re-run the fetch belongs in the key.
 *
 * This module provides the default CLIENT semantics. Server renderers
 * install per-instance providers (`_useAsync` on the setup context) that
 * take over during SSR — the whole options bag passes through the seam
 * untouched (open interface: packs augment `AsyncOptions` and read their
 * own keys on the other side).
 */

import { watch } from '@sigx/reactivity';
import { getCurrentInstance } from './component-lifecycle.js';
import {
    resolveKeyResult,
    assertKeyArgShape,
    type Falsy,
    type KeyValue,
    type KeyWarnFlags,
} from './async/key.js';
import { createDataCell, INERT_IDLE_CELL } from './async/cell.js';
import {
    warnUnknownOptions,
    type AsyncFetcherContext,
    type AsyncState,
    type Fetcher,
} from './async/shared.js';

export type { Falsy, KeyTuple, KeyValue } from './async/key.js';
export type { AsyncFetcherContext, Fetcher, MatchArms, AsyncState } from './async/shared.js';

/**
 * OPEN interface — contains only options core actually reads. A pack
 * augments it (`declare module …`) so its options exist in the editor
 * exactly when the pack is installed; core passes the whole bag through the
 * provider seam untouched, and the default engine dev-warns on options no
 * installed plugin handles.
 */
export interface AsyncOptions {
    /**
     * Run the fetcher on the server. Default: true. `server: false` makes the
     * read client-only (SSR renders the pending arm; the client fetches after
     * hydration) — it keeps its key for dedupe and future cache coverage.
     */
    server?: boolean;
}

/** Option keys the default engine itself reads. */
const handledReadOptionKeys: ReadonlySet<string> = new Set(['server']);

/** Static key: runs on the server, serialized under `key`, restored on hydration. */
export function useData<T>(key: string, fetcher: Fetcher<T, string>, opts?: AsyncOptions): AsyncState<T>;
/** Reactive key: string or tuple; a falsy result skips the fetch (state 'idle'). */
export function useData<T, const K extends KeyValue>(
    key: () => K | Falsy,
    fetcher: Fetcher<T, K>,
    opts?: AsyncOptions
): AsyncState<T>;
export function useData<T>(
    keyArg: string | (() => KeyValue | Falsy),
    fetcher: Fetcher<T, any>,
    options?: AsyncOptions
): AsyncState<T> {
    const shape = assertKeyArgShape(keyArg);

    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useData() must be called synchronously during component setup.');
    }

    const warns: KeyWarnFlags = {};

    // Environment provider (server render) takes over. The key getter is
    // resolved ONCE (no reactivity server-side) and the fetcher pre-bound
    // with its argument, so the seam's shape stays (key, fetcher, options).
    if ((instance as any)._useAsync) {
        const raw = shape === 'getter' ? (keyArg as () => KeyValue | Falsy)() : (keyArg as string);
        const canon = resolveKeyResult(raw, warns);
        if (canon === null) return INERT_IDLE_CELL as AsyncState<T>;
        return (instance as any)._useAsync(
            canon,
            (ctx: AsyncFetcherContext) => fetcher(raw as KeyValue, ctx),
            options ?? {}
        ) as AsyncState<T>;
    }

    // ── Default client semantics ──
    if (process.env.NODE_ENV !== 'production') {
        warnUnknownOptions('useData', options, handledReadOptionKeys);
    }

    const handle = createDataCell<T>(fetcher as (arg: unknown, ctx: AsyncFetcherContext) => Promise<T>, instance);

    if (shape === 'static') {
        handle.setKey(resolveKeyResult(keyArg as string, warns), keyArg);
        instance.onUnmounted(() => handle.dispose());
    } else {
        const getter = keyArg as () => KeyValue | Falsy;
        let raw: KeyValue | Falsy;
        // The watch source returns the CANONICAL string, so equal-content
        // fresh tuples share one identity; the raw value rides a closure to
        // stay available as the fetcher's argument. The callback body runs
        // untracked inside the cell (see setKey).
        const watcher = watch(
            () => {
                raw = getter();
                return resolveKeyResult(raw, warns);
            },
            (canon) => handle.setKey(canon, raw),
            { immediate: true }
        );
        instance.onUnmounted(() => {
            watcher.stop();
            handle.dispose();
        });
    }

    return handle.cell;
}
