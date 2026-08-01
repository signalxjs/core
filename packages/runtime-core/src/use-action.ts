/**
 * useAction — THE async write (docs/rfc-async.md rev 8).
 *
 * The manual counterpart to `useData`: never auto-runs, triggered by
 * `.run(input)`. `run` never rejects — it resolves a `RunResult` so both
 * fire-and-forget and `const r = await save.run()` are safe. In-flight
 * requests are NEVER aborted (an aborted POST is not an undone POST); a
 * newer `run()` or `reset()` merely supersedes the OBSERVATION — the older
 * run's promise resolves `{ ok: false, error: SupersededError }` and never
 * writes state.
 *
 * Cross-read invalidation is explicit: on success call `user.refresh()`.
 * Cache-aware invalidate/optimistic mutate arrive with a pack, attached via
 * the open `ActionOptions` interface.
 */

import { signal, batch, untrack } from '@sigx/reactivity';
import { getCurrentInstance } from './component-lifecycle.js';
import { hookOutsideSetupError } from './errors.js';
import { ASYNC_ENGINE_TOKEN } from './async/engine.js';
import { lookupProvided } from './di/injectable.js';
import {
    matchAsyncState,
    makeUnhandledReporter,
    makeAbortController,
    inertAbortSignal,
    normalizeError,
    warnUnknownOptions,
    type AsyncFetcherContext,
    type Fetcher,
    type MatchArms,
    type ValuePresence,
} from './async/shared.js';

/** A superseded run resolves { ok: false, error: SupersededError } and never writes `.error`. */
export class SupersededError extends Error {
    override readonly name = 'SupersededError';
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: Error };

/** OPEN interface — deliberately empty in core; packs augment it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ActionOptions {}

/** Methods shared by every {@link AsyncAction} member. */
export interface AsyncActionBase<T, In> {
    match<R>(arms: MatchArms<T, R>): R | undefined;
    /**
     * Trigger. Never rejects; in-flight runs are never aborted.
     * `In = void` ⇒ callable as `run()` (TS permits omitting a void-typed
     * parameter).
     */
    run(input: In): Promise<RunResult<T>>;
    /**
     * Back to 'idle'; clears value/error (dismiss a success message, reuse a
     * form). Discards observation of an in-flight run (its promise resolves
     * SupersededError); never aborts the request.
     */
    reset(): void;
}

/**
 * A discriminated union like {@link AsyncState} (same narrowing:
 * `if (a.hasValue) a.value // T`), with action-specific semantics — no
 * 'refreshing'; `value` is the LAST SUCCESSFUL result and survives both a
 * re-run ('pending' — a search box renders from it) and a failure
 * ('errored' — SWR-through-error); `loading` is the blessed double-submit
 * guard: disabled={a.loading}. Only `reset()` clears the value.
 */
export type AsyncAction<T, In> = AsyncActionBase<T, In> &
    (
        | { readonly state: 'idle'; readonly value: null; readonly hasValue: false; readonly error: null; readonly loading: false }
        | ({ readonly state: 'pending'; readonly error: null; readonly loading: true } & ValuePresence<T>)
        | { readonly state: 'ready'; readonly value: T; readonly hasValue: true; readonly error: null; readonly loading: false }
        | ({ readonly state: 'errored'; readonly error: Error; readonly loading: false } & ValuePresence<T>)
    );

/** Option keys the default engine itself reads — none; the interface is a pack seam. */
const handledActionOptionKeys: ReadonlySet<string> = new Set();

export function useAction<T, In = void>(fn: Fetcher<T, In>, opts?: ActionOptions): AsyncAction<T, In> {
    const instance = getCurrentInstance();
    if (!instance) {
        throw hookOutsideSetupError('useAction');
    }

    // An app-provided engine (§7 pack) may wrap the action — optimistic
    // apply, cache-aware invalidation. Its declared option keys silence the
    // unknown-option warning via registerHandledAsyncOptionKeys.
    const engine = lookupProvided(ASYNC_ENGINE_TOKEN);

    if (__DEV__) {
        warnUnknownOptions('useAction', opts, handledActionOptionKeys);
    }

    const state = signal({
        st: 'idle' as 'idle' | 'pending' | 'ready' | 'errored',
        data: null as T | null,
        err: null as Error | null,
        /** `data` is a VALUE (the last success) — presence, not a null test (#485). */
        has: false,
    });

    /** Supersede token: bumped by every run(), reset(), and unmount. */
    let seq = 0;
    let lastInput: In;
    let hasRun = false;

    const reportUnhandled = makeUnhandledReporter(instance, 'useAction');

    function superseded(): RunResult<T> {
        return { ok: false, error: new SupersededError('This run was superseded by a newer run() or reset().') };
    }

    async function run(input: In): Promise<RunResult<T>> {
        lastInput = input;
        hasRun = true;
        const id = ++seq;

        untrack(() =>
            batch(() => {
                state.st = 'pending';
                state.err = null;
            })
        );

        // Feature-detected controller whose signal is handed to the fetcher
        // but NEVER aborted by the engine — actions are not cancellable.
        const ctrl = makeAbortController();
        const ctx: AsyncFetcherContext = { signal: ctrl ? ctrl.signal : inertAbortSignal() };

        try {
            let p: Promise<T>;
            try {
                p = fn(input, ctx);
            } catch (e) {
                p = Promise.reject(e);
            }
            const v = await p;
            if (id !== seq) return superseded(); // never writes state
            untrack(() =>
                batch(() => {
                    state.st = 'ready';
                    state.data = v;
                    state.has = true;
                    state.err = null;
                })
            );
            return { ok: true, value: v };
        } catch (e) {
            if (id !== seq) return superseded(); // never writes `.error`
            const err = normalizeError(e);
            untrack(() =>
                batch(() => {
                    // SWR-through-error: the last success survives in
                    // `data`/`has` — only reset() clears it.
                    state.st = 'errored';
                    state.err = err;
                })
            );
            return { ok: false, error: err };
        }
    }

    function reset(): void {
        seq++;
        untrack(() =>
            batch(() => {
                state.st = 'idle';
                state.data = null;
                state.has = false;
                state.err = null;
            })
        );
    }

    // An unmounted component must never receive late state writes; the
    // request itself is left to finish (never aborted).
    instance.onUnmounted(() => {
        seq++;
    });

    // Wide impl shape, cast to the union at the seam (see AsyncStateImpl).
    const action = {
        get state() {
            return state.st;
        },
        get value() {
            return state.data;
        },
        get hasValue() {
            return state.has;
        },
        get error() {
            return state.err;
        },
        get loading() {
            return state.st === 'pending';
        },
        match<R>(arms: MatchArms<T, R>): R | undefined {
            return matchAsyncState<T, R>(
                {
                    state: state.st,
                    value: state.data,
                    hasValue: state.has,
                    error: state.err,
                    pendingKeepsValue: true,
                    // Write-retry: re-run with the last input. (A zero-arg
                    // closure re-reads current signals by construction.)
                    retry: () => {
                        if (hasRun) void run(lastInput);
                    },
                    onUnhandledError: reportUnhandled,
                },
                arms
            );
        },
        run,
        reset,
    } as AsyncAction<T, In>;

    return engine?.wrapAction ? engine.wrapAction(action, opts ?? {}, instance) : action;
}
