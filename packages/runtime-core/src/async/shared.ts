/**
 * Shared async surface — the types, the `match` dispatch table, and the
 * option-bag dev warning used by `useData`, `useAction`, and `all()`.
 *
 * Deliberately free of the data-cell engine and the SSR blob: `useAction`
 * and `all()` import only this module, so an app that never calls `useData`
 * tree-shakes the entire keyed-data layer (including the `__SIGX_ASYNC__`
 * pickup) out of its bundle.
 */

import type { ComponentSetupContext } from '../component-types.js';
import { reportUnhandledAsyncError } from '../app.js';

export interface AsyncFetcherContext {
    /**
     * Pass it straight to fetch():  fetch(url, { signal })
     *
     * Reads: aborted only when this cell is the fetch's sole consumer and
     * the run is superseded (keyed fetches may be SHARED — dedupe).
     * Actions: never aborted (an aborted POST is not an undone POST).
     */
    signal: AbortSignal;
}

/** One fetcher shape everywhere: (trigger's argument, ctx). */
export type Fetcher<T, Arg> = (arg: Arg, ctx: AsyncFetcherContext) => Promise<T>;

export type AsyncStateName = 'idle' | 'pending' | 'ready' | 'refreshing' | 'errored';

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
    readonly state: AsyncStateName;
    /** SWR last-good; kept across same-key refresh(), CLEARED on key change. */
    readonly value: T | null;
    readonly error: Error | null;
    /** state === 'pending' ONLY — "nothing to show yet". Refresh indicators read state === 'refreshing'. */
    readonly loading: boolean;
    match<R>(arms: MatchArms<T, R>): R | undefined;
    /** Re-run in place. NEVER rejects — failures land on `.error`. */
    refresh(): Promise<void>;
}

/** Brand identifying engine-made cells — `all()` uses it to tell the object form from a single-member tuple. @internal */
export const CELL: unique symbol = Symbol('sigx:asyncCell');
/** Non-enumerable getter exposing a cell's internal last-good value so `all()` can combine stales. @internal */
export const STALE: unique symbol = Symbol('sigx:asyncStale');

/** @internal */
export function isCell(v: unknown): boolean {
    return !!v && (v as Record<symbol, unknown>)[CELL] === true;
}

/**
 * The state→arm dispatch table (shared by client cells, actions, `all()`,
 * and the server renderer's provider).
 *
 * @internal
 */
export function matchAsyncState<T, R>(
    view: {
        state: AsyncStateName;
        value: T | null;
        error: Error | null;
        stale: T | null;
        retry: () => void;
        /** Called when the cell is errored and no `error` arm was given. */
        onUnhandledError?: (e: Error) => void;
    },
    arms: MatchArms<T, R>
): R | undefined {
    switch (view.state) {
        case 'idle':
            return (arms.idle ?? arms.pending)?.();
        case 'pending':
            return arms.pending?.();
        case 'ready':
        case 'refreshing':
            return arms.ready(view.value as T);
        case 'errored':
            if (arms.error) return arms.error(view.error as Error, view.retry, view.stale);
            view.onUnhandledError?.(view.error as Error);
            return undefined;
    }
}

/** Coerce a rejection reason to an Error (non-Error throws are wrapped). @internal */
export function normalizeError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
}

/**
 * Build the missing-error-arm reporter for one cell: a one-time dev warning
 * plus one bubble to errorScope / app `onError` per distinct error instance
 * (a cell re-rendering with the same error must not re-report it).
 *
 * @internal
 */
export function makeUnhandledReporter(
    instance: ComponentSetupContext<any, any, any> | null,
    label: string
): (e: Error) => void {
    let warned = false;
    let reported: Error | null = null;
    return (e) => {
        if (process.env.NODE_ENV !== 'production' && !warned) {
            warned = true;
            console.warn(
                `[${label}] a data error had no \`error\` arm in match() — it bubbled to the nearest ` +
                'errorScope / app onError. Add an `error` arm to handle it locally.',
                e
            );
        }
        if (reported !== e) {
            reported = e;
            reportUnhandledAsyncError(e, instance);
        }
    };
}

// ============= Option-bag dev warning =============

/**
 * Option keys claimed by installed packs (via `registerHandledAsyncOptionKeys`,
 * the provider-seam counterpart for the default engine's warning).
 */
const packHandledOptionKeys = new Set<string>();
const warnedUnknownOptions = new Set<string>();

/**
 * Declare option keys as handled so the default engine's unknown-option
 * warning stays quiet for them. Called by packs that wrap the async engine.
 *
 * @internal
 */
export function registerHandledAsyncOptionKeys(...keys: string[]): void {
    for (const k of keys) packHandledOptionKeys.add(k);
}

/**
 * Dev warning of the default engine: an option key nobody handles is almost
 * always a missing plugin install (e.g. a cache pack). The whole bag still
 * flows through the provider seam untouched — this never validates or strips.
 *
 * @internal
 */
export function warnUnknownOptions(
    fnName: string,
    options: object | undefined,
    coreKeys: ReadonlySet<string>
): void {
    if (process.env.NODE_ENV === 'production' || !options) return;
    for (const k of Object.keys(options)) {
        if (coreKeys.has(k) || packHandledOptionKeys.has(k) || warnedUnknownOptions.has(k)) continue;
        warnedUnknownOptions.add(k);
        console.warn(
            `[${fnName}] option '${k}' was passed but no installed plugin handles it — ` +
            'did you forget to install the pack that provides it (e.g. app.use(cachePlugin()))?'
        );
    }
}

// ============= AbortController feature detection =============

let inertSignal: AbortSignal | undefined;

/**
 * A never-aborting stand-in for environments without `AbortController`
 * (embedded runtimes). Fetchers can pass it to APIs unconditionally.
 *
 * @internal
 */
export function inertAbortSignal(): AbortSignal {
    return (inertSignal ??= Object.freeze({
        aborted: false,
        reason: undefined,
        onabort: null,
        throwIfAborted() { },
        addEventListener() { },
        removeEventListener() { },
        dispatchEvent: () => false,
    }) as unknown as AbortSignal);
}

/** Create an AbortController when the platform has one. @internal */
export function makeAbortController(): AbortController | null {
    return typeof AbortController === 'function' ? new AbortController() : null;
}
