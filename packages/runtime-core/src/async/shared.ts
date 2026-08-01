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

/**
 * The presence pair: `hasValue` is the discriminant that makes `value` a `T`.
 *
 * `value !== null` cannot answer "is there a value?" for a nullable `T` — a
 * fetch that legitimately resolves `null` (a "not found" read) is a VALUE
 * (#485). `if (x.hasValue) x.value // T` is the type-safe form of that
 * question, everywhere this pair appears.
 */
export type ValuePresence<T> =
    | { readonly value: T; readonly hasValue: true }
    | { readonly value: null; readonly hasValue: false };

/**
 * Second parameter of the `error` arm. `value`/`hasValue` are the surviving
 * last-good (the same thing the state's own `value` holds during `'errored'`)
 * — a legitimately-null last-good has `hasValue: true`.
 */
export type ErrorArmContext<T> = { readonly retry: () => void } & ValuePresence<T>;

export interface MatchArms<T, R> {
    /** Conditional fetch not started ("Type to search…"). Defaults to `pending`. */
    idle?: () => R;
    /** Nothing to show yet. Omitted ⇒ renders nothing while pending. */
    pending?: () => R;
    /**
     * Fetch failed. "Keep content + toast" reads `ctx.value`/`ctx.hasValue`
     * (the surviving last-good); the common case destructures just
     * `(e, { retry })`. Omitted ⇒ undefined + bubble to errorScope / app
     * onError.
     */
    error?: (e: Error, ctx: ErrorArmContext<T>) => R;
    /**
     * The happy path. Reached when the cell HAS a value — which for a nullable
     * `T` includes a legitimately `null` one, so this is "the value is
     * present", not "the value is non-null" (#485).
     */
    ready: (v: T) => R;
}

/** Methods shared by every {@link AsyncState} member. */
export interface AsyncStateBase<T> {
    match<R>(arms: MatchArms<T, R>): R | undefined;
    /** Re-run in place. NEVER rejects — failures land on `.error`. */
    refresh(): Promise<void>;
}

export interface AsyncIdle<T> extends AsyncStateBase<T> {
    readonly state: 'idle';
    readonly value: null;
    readonly hasValue: false;
    readonly error: null;
    readonly loading: false;
}
export interface AsyncPending<T> extends AsyncStateBase<T> {
    readonly state: 'pending';
    readonly value: null;
    readonly hasValue: false;
    readonly error: null;
    readonly loading: true;
}
export interface AsyncReady<T> extends AsyncStateBase<T> {
    readonly state: 'ready';
    readonly value: T;
    readonly hasValue: true;
    readonly error: null;
    readonly loading: false;
}
export interface AsyncRefreshing<T> extends AsyncStateBase<T> {
    readonly state: 'refreshing';
    readonly value: T;
    readonly hasValue: true;
    readonly error: null;
    readonly loading: false;
}
/**
 * SWR-through-error: the last-good value survives a failed same-key fetch, so
 * this member genuinely splits on presence — `hasValue: true` after a failed
 * refresh of settled data, `false` when the cell never succeeded.
 */
export type AsyncErrored<T> = AsyncStateBase<T> & {
    readonly state: 'errored';
    readonly error: Error;
    readonly loading: false;
} & ValuePresence<T>;

/**
 * Reactive — reads inside a render fn subscribe like any signal.
 *
 * A discriminated union over one STABLE object: `if (x.hasValue) x.value // T`
 * and `if (x.state === 'ready') x.value // T` both narrow. Narrowing is a
 * per-read snapshot — the underlying state moves on, so re-check after an
 * `await` (render fns re-run and re-narrow on every change; this only matters
 * in event handlers and async code).
 *
 * Invariants every producer upholds (dev-checked in `matchAsyncState`):
 * `value` is the SWR last-good — kept across same-key refresh() AND across a
 * failed fetch, CLEARED on key change; `loading` is `state === 'pending'`
 * ONLY ("nothing to show yet" — refresh indicators read `'refreshing'`).
 */
export type AsyncState<T> =
    | AsyncIdle<T>
    | AsyncPending<T>
    | AsyncReady<T>
    | AsyncRefreshing<T>
    | AsyncErrored<T>;

/**
 * The WIDE shape an engine implements — build one of these (getters over your
 * own state machine) and return it `as AsyncState<T>` at the seam; the union
 * is how CONSUMERS see it, not a shape TypeScript can check a stable getter
 * object against. Invariants the cast asserts (dev-warned in
 * `matchAsyncState`): idle/pending ⇒ `hasValue` false & `error` null;
 * ready/refreshing ⇒ `hasValue` true & `error` null; errored ⇒ `error`
 * non-null; `loading` ⇔ pending.
 *
 * @internal — the §7 pack contract surface.
 */
export interface AsyncStateImpl<T> {
    readonly state: AsyncStateName;
    readonly value: T | null;
    readonly hasValue: boolean;
    readonly error: Error | null;
    readonly loading: boolean;
    match<R>(arms: MatchArms<T, R>): R | undefined;
    refresh(): Promise<void>;
}

/** Brand identifying engine-made cells — `all()` uses it to tell the object form from a single-member tuple. @internal */
export const CELL: unique symbol = Symbol('sigx:asyncCell');

/** @internal */
export function isCell(v: unknown): boolean {
    return !!v && (v as Record<symbol, unknown>)[CELL] === true;
}

/** One warning per distinct producer bug, not one per render. */
const invariantWarned = __DEV__ ? new Set<string>() : null!;

/**
 * The state→arm dispatch table (shared by client cells, actions, `all()`,
 * and the server renderer's provider).
 *
 * In dev it also checks the {@link AsyncStateImpl} invariants — the honesty
 * check behind every producer's `as AsyncState<T>` cast, third-party engines
 * included.
 *
 * @internal
 */
export function matchAsyncState<T, R>(
    view: {
        state: AsyncStateName;
        value: T | null;
        hasValue: boolean;
        error: Error | null;
        retry: () => void;
        /** Actions keep the last success visible while 'pending' — data cells never do. */
        pendingKeepsValue?: boolean;
        /** Called when the cell is errored and no `error` arm was given. */
        onUnhandledError?: (e: Error) => void;
    },
    arms: MatchArms<T, R>
): R | undefined {
    if (__DEV__) {
        const s = view.state;
        const bug =
            (s === 'idle' || (s === 'pending' && !view.pendingKeepsValue)) && view.hasValue
                ? `state '${s}' must have hasValue: false`
                : (s === 'ready' || s === 'refreshing') && !view.hasValue
                    ? `state '${s}' must have hasValue: true`
                    : s !== 'errored' && view.error
                        ? `state '${s}' must have error: null`
                        : s === 'errored' && !view.error
                            ? "state 'errored' must carry a non-null error"
                            : null;
        if (bug && !invariantWarned.has(bug)) {
            invariantWarned.add(bug);
            console.warn(`[AsyncState] producer invariant violated: ${bug} — the engine that built this state is lying to the union type.`);
        }
    }
    switch (view.state) {
        case 'idle':
            return (arms.idle ?? arms.pending)?.();
        case 'pending':
            return arms.pending?.();
        case 'ready':
        case 'refreshing':
            return arms.ready(view.value as T);
        case 'errored':
            if (arms.error) {
                return arms.error(view.error as Error, {
                    retry: view.retry,
                    value: view.value,
                    hasValue: view.hasValue,
                } as ErrorArmContext<T>);
            }
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
        if (__DEV__ && !warned) {
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
    if (!__DEV__ || !options) return;
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
