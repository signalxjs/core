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
} from './async/shared.js';

/** A superseded run resolves { ok: false, error: SupersededError } and never writes `.error`. */
export class SupersededError extends Error {
    override readonly name = 'SupersededError';
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: Error };

/** OPEN interface — deliberately empty in core; packs augment it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ActionOptions {}

export interface AsyncAction<T, In> {
    readonly state: 'idle' | 'pending' | 'ready' | 'errored'; // no 'refreshing'
    /** Last successful result (a search box renders from this). */
    readonly value: T | null;
    readonly error: Error | null;
    /** state === 'pending' — the blessed double-submit guard: disabled={a.loading}. */
    readonly loading: boolean;
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

/** Option keys the default engine itself reads — none; the interface is a pack seam. */
const handledActionOptionKeys: ReadonlySet<string> = new Set();

export function useAction<T, In = void>(fn: Fetcher<T, In>, opts?: ActionOptions): AsyncAction<T, In> {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('useAction() must be called synchronously during component setup.');
    }

    if (process.env.NODE_ENV !== 'production') {
        warnUnknownOptions('useAction', opts, handledActionOptionKeys);
    }

    const state = signal({
        st: 'idle' as AsyncAction<T, In>['state'],
        data: null as T | null,
        err: null as Error | null,
    });

    /** Supersede token: bumped by every run(), reset(), and unmount. */
    let seq = 0;
    let lastInput: In;
    let hasRun = false;
    /** Last successful value — handed to the error arm as `stale`. */
    let stale: T | null = null;

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
            stale = v;
            untrack(() =>
                batch(() => {
                    state.st = 'ready';
                    state.data = v;
                    state.err = null;
                })
            );
            return { ok: true, value: v };
        } catch (e) {
            if (id !== seq) return superseded(); // never writes `.error`
            const err = normalizeError(e);
            untrack(() =>
                batch(() => {
                    // value/error stay mutually exclusive; the last success
                    // survives in `stale` for the error arm.
                    state.st = 'errored';
                    state.data = null;
                    state.err = err;
                })
            );
            return { ok: false, error: err };
        }
    }

    function reset(): void {
        seq++;
        stale = null;
        untrack(() =>
            batch(() => {
                state.st = 'idle';
                state.data = null;
                state.err = null;
            })
        );
    }

    // An unmounted component must never receive late state writes; the
    // request itself is left to finish (never aborted).
    instance.onUnmounted(() => {
        seq++;
    });

    return {
        get state() {
            return state.st;
        },
        get value() {
            return state.data;
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
                    error: state.err,
                    stale,
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
    };
}
