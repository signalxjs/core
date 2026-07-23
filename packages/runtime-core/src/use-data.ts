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
import { hookOutsideSetupError } from './errors.js';
import {
    resolveKeyResult,
    assertKeyArgShape,
    isServerFnDataRef,
    type Falsy,
    type KeyTuple,
    type KeyValue,
    type KeyWarnFlags,
    type ServerFnDataRef,
} from './async/key.js';
import { INERT_IDLE_CELL } from './async/cell.js';
import { ASYNC_ENGINE_TOKEN, defaultAsyncEngine } from './async/engine.js';
import { lookupProvided } from './di/injectable.js';
import {
    warnUnknownOptions,
    type AsyncFetcherContext,
    type AsyncState,
    type Fetcher,
} from './async/shared.js';

export type { Falsy, KeyTuple, KeyValue, ServerFnDataRef } from './async/key.js';
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

/**
 * Default fetcher for server-fn keys (#452): a fn-headed tuple
 * `[fn, ...args]` calls `fn(...args)` — the RPC stub on the client, the
 * real wrapper in-process during SSR. Any other key shape without an
 * explicit fetcher is an authoring error (type-blocked; this throw is the
 * runtime backstop).
 */
const refTupleFetcher = (raw: KeyValue, _ctx: AsyncFetcherContext): Promise<unknown> => {
    if (Array.isArray(raw) && isServerFnDataRef(raw[0])) {
        const args = raw.slice(1) as unknown as KeyTuple;
        return Promise.resolve((raw[0] as unknown as ServerFnDataRef)(...args));
    }
    throw new TypeError(
        '[useData] no fetcher given and the key is not a server-fn reference — only ' +
        'useData(fn) / useData(() => [fn, ...args]) have a default fetcher.'
    );
};

/** Server-fn key (#452): data identity IS the fn — canonical key
 *  `'["<stableId>#<name>"]'`, default fetcher `() => fn()`. */
export function useData<R>(fn: ServerFnDataRef<[], R>, opts?: AsyncOptions): AsyncState<Awaited<R>>;
/** Reactive server-fn tuple key: `() => [fn, ...args]`; falsy ⇒ idle.
 *  Default fetcher `fn(...args)`; args are the fn's own parameters. */
export function useData<A extends KeyTuple, R>(
    key: () => readonly [ServerFnDataRef<A, R>, ...A] | Falsy,
    opts?: AsyncOptions
): AsyncState<Awaited<R>>;
/** Static key: runs on the server, serialized under `key`, restored on hydration. */
export function useData<T>(key: string, fetcher: Fetcher<T, string>, opts?: AsyncOptions): AsyncState<T>;
/** Reactive key: string or tuple; a falsy result skips the fetch (state 'idle'). */
export function useData<T, const K extends KeyValue>(
    key: () => K | Falsy,
    fetcher: Fetcher<T, K>,
    opts?: AsyncOptions
): AsyncState<T>;
export function useData<T>(
    keyArg: string | (() => KeyValue | Falsy) | ServerFnDataRef<[], unknown>,
    fetcherOrOptions?: Fetcher<T, any> | AsyncOptions,
    optionsArg?: AsyncOptions
): AsyncState<T> {
    let fetcher =
        typeof fetcherOrOptions === 'function' ? (fetcherOrOptions as Fetcher<T, any>) : undefined;
    const options =
        typeof fetcherOrOptions === 'function'
            ? optionsArg
            : (fetcherOrOptions as AsyncOptions | undefined);

    // Server-fn key sugar (#452) — brand check FIRST: assertKeyArgShape
    // would classify the ref as a key GETTER, and useData would invoke the
    // RPC to compute a key. The key becomes the fn-headed tuple `[ref]`
    // (static by construction — fn identity never changes); resolveKeyResult
    // canonicalizes the ref to its stable-key string, and the raw tuple
    // stays the (default) fetcher's argument.
    let shape: 'static' | 'getter';
    if (isServerFnDataRef(keyArg)) {
        keyArg = [keyArg] as unknown as string;
        shape = 'static';
    } else {
        if (
            __DEV__ &&
            typeof keyArg === 'function' &&
            ('__sigxFn' in keyArg || '__sigxKey' in keyArg)
        ) {
            // A server fn/stub reached here WITHOUT a usable stamped key —
            // treating it as a key getter would fire the RPC to name a key.
            throw new TypeError(
                '[useData] this server fn has no build-stamped key (__sigxKey) — the Vite ' +
                'transform stamps it. In tests, set fn.__sigxKey manually or use a ' +
                'string/tuple key with an explicit fetcher.'
            );
        }
        shape = assertKeyArgShape(keyArg);
    }
    fetcher ??= refTupleFetcher as unknown as Fetcher<T, any>;

    const instance = getCurrentInstance();
    if (!instance) {
        throw hookOutsideSetupError('useData');
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

    // ── Client semantics: an app-provided engine (a cache pack installed
    // via app.use(...)) or the default engine. Core keeps the key machinery
    // either way — the engine sees resolved canonical keys. ──
    const engine = lookupProvided(ASYNC_ENGINE_TOKEN) ?? defaultAsyncEngine;

    // The warning consults the shared handled-keys registry, so an installed
    // pack's own options stay quiet (it registered them at install) while
    // typos keep warning even with an engine present.
    if (__DEV__) {
        warnUnknownOptions('useData', options, handledReadOptionKeys);
    }

    const handle = engine.read<T>(
        fetcher as (arg: unknown, ctx: AsyncFetcherContext) => Promise<T>,
        options ?? {},
        instance
    );

    if (shape === 'static') {
        handle.setKey(resolveKeyResult(keyArg as KeyValue, warns), keyArg);
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

    return handle.state;
}
