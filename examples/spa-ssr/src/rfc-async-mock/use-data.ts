/**
 * ════════════════════════════════════════════════════════════════════════
 *  DESIGN MOCK — `useData` / `useAction` (docs/rfc-async.md). NOT implemented.
 *
 *  This file exists so the RFC can be inspected in an editor with real
 *  types: hover the examples in ./examples.tsx to see inference at work.
 *  The runtime here is inert (cells never fetch); only the surface — the
 *  overloads, tuple-key inference, `match` narrowing, `all()` inference,
 *  and the `RunResult` contract — is faithful. It is the acceptance gate
 *  for the Phase-1 surface (rfc-async.md, "Inspectable mock").
 *
 *  Design rules under test:
 *    useData(key, fn)                  → static key: SSR-transferable
 *    useData(() => key, fn)            → reactive key: string OR tuple; falsy ⇒ idle
 *    useData(key, fn, {server:false})  → client-only (still keyed — rev 8:
 *                                        there is NO bare-fetcher form)
 *    useAction(fn, opts?)              → write: never auto-runs; .run() never rejects
 * ════════════════════════════════════════════════════════════════════════
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

/** All skip values — including '' so `str && tuple` getters type cleanly. */
export type Falsy = null | undefined | false | '';
/** Tuple elements are JSON primitives only — identity is canonical JSON (open question 2). */
export type KeyTuple = readonly (string | number | boolean | null)[];
export type KeyValue = string | KeyTuple;

export interface AsyncFetcherContext {
    /**
     * Reads: aborted only when this cell is the fetch's sole consumer and
     * the run is superseded (keyed fetches may be SHARED — dedupe).
     * Actions: never aborted (an aborted POST is not an undone POST).
     */
    signal: AbortSignal;
}

/** One fetcher shape everywhere: (trigger's argument, ctx). */
export type Fetcher<T, Arg> = (arg: Arg, ctx: AsyncFetcherContext) => Promise<T>;

/**
 * OPEN interface (rev 7) — contains only options core actually reads.
 * A pack augments it (`declare module …`) so its options exist in the editor
 * exactly when the pack is installed; core passes the whole bag through the
 * provider seam untouched, and the default engine dev-warns on options no
 * installed plugin handles. See ./examples.tsx for the augmentation pattern.
 */
export interface AsyncOptions {
    /**
     * Run the fetcher on the server. Default: true. `server: false` makes the
     * read client-only (SSR renders the pending arm; the client fetches after
     * hydration) — it keeps its key for dedupe and future cache coverage.
     */
    server?: boolean;
}

/** OPEN interface (rev 7) — deliberately empty in core; packs augment it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ActionOptions {}

export interface MatchArms<T, R> {
    /** Conditional fetch not started ("Type to search…"). Defaults to `pending`. */
    idle?: () => R;
    /** Nothing to show yet. Omitted ⇒ renders nothing while pending. */
    pending?: () => R;
    /**
     * Fetch failed. `stale` is the last-good value (survives internally even
     * though top-level `value` is nulled) — "keep content + toast" needs no
     * extra state. Omitted ⇒ null + bubble to errorScope / app onError.
     */
    error?: (e: Error, retry: () => void, stale: T | null) => R;
    /** The happy path — the only type-safe route to a non-null T. */
    ready: (v: T) => R;
}

/** Reactive — reads inside a render fn subscribe like any signal. */
export interface AsyncState<T> {
    readonly state: 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';
    /** SWR last-good; kept across same-key refresh(), CLEARED on key change. */
    readonly value: T | null;
    readonly error: Error | null;
    /** state === 'pending' ONLY — "nothing to show yet". Refresh indicators read state === 'refreshing'. */
    readonly loading: boolean;
    match<R>(arms: MatchArms<T, R>): R | undefined;
    /** Re-run in place. NEVER rejects — failures land on `.error`. */
    refresh(): Promise<void>;
}

/** A superseded run resolves { ok: false, error: SupersededError } and never writes `.error`. */
export class SupersededError extends Error {
    override readonly name = 'SupersededError';
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: Error };

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
     * parameter — see the compile-time proof in ./examples.tsx).
     */
    run(input: In): Promise<RunResult<T>>;
    /**
     * Back to 'idle'; clears value/error (dismiss a success message, reuse a
     * form). Discards observation of an in-flight run (its promise resolves
     * SupersededError); never aborts the request.
     */
    reset(): void;
}

export interface AllState<T, E> extends AsyncState<T> {
    /** Collect-all counterpart to first-error-wins `.error`. */
    readonly errors: E;
}

// ─── inert mock runtime ─────────────────────────────────────────────────

function inertCell<T>(): AsyncState<T> {
    const cell: AsyncState<T> = {
        state: 'idle',
        value: null,
        error: null,
        loading: false,
        match<R>(arms: MatchArms<T, R>): R | undefined {
            // exactly the state→arm table from the RFC
            switch (cell.state) {
                case 'idle':
                    return (arms.idle ?? arms.pending)?.();
                case 'pending':
                    return arms.pending?.();
                case 'ready':
                case 'refreshing':
                    return arms.ready(cell.value as T);
                case 'errored':
                    return arms.error?.(cell.error as Error, () => void cell.refresh(), null);
            }
        },
        refresh: () => Promise.resolve(),
    };
    return cell;
}

// ─── useData overloads ──────────────────────────────────────────────────

// Rev 8: there is NO bare-fetcher overload — every read has a key. A lone
// function as the first argument is a compile error by design (it used to
// compile as an unkeyed, untracked, non-SSR read).
export function useData<T>(key: string, fetcher: Fetcher<T, string>, opts?: AsyncOptions): AsyncState<T>;
export function useData<T, const K extends KeyValue>(
    key: () => K | Falsy,
    fetcher: Fetcher<T, K>,
    opts?: AsyncOptions
): AsyncState<T>;
export function useData(
    _key: unknown,
    _fetcher: unknown,
    _opts?: unknown
): AsyncState<unknown> {
    return inertCell<unknown>();
}

// ─── useAction ──────────────────────────────────────────────────────────

export function useAction<T, In = void>(fn: Fetcher<T, In>, opts?: ActionOptions): AsyncAction<T, In> {
    void fn;
    void opts;
    const base = inertCell<T>();
    return {
        state: 'idle',
        value: base.value,
        error: base.error,
        loading: false,
        match: base.match.bind(base),
        run: (_input: In) =>
            Promise.resolve<RunResult<T>>({ ok: false, error: new SupersededError('mock') }),
        reset: () => {},
    };
}

// ─── all() — object form primary, rest-tuple for quick cases ────────────

type ValuesOf<S> = { [K in keyof S]: S[K] extends AsyncState<infer V> ? V : never };
type ErrorsOf<S> = { [K in keyof S]: Error | null };

export function all<S extends Record<string, AsyncState<unknown>>>(
    sources: S
): AllState<ValuesOf<S>, ErrorsOf<S>>;
export function all<S extends readonly AsyncState<unknown>[]>(
    ...sources: S
): AllState<ValuesOf<S>, ErrorsOf<S>>;
export function all(..._sources: unknown[]): AllState<unknown, unknown> {
    const base = inertCell<unknown>();
    return {
        state: base.state,
        value: base.value,
        error: base.error,
        loading: base.loading,
        match: base.match.bind(base),
        refresh: base.refresh, // refreshes ALL members in parallel; never rejects
        errors: {},
    };
}
