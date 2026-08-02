/**
 * `perRequest` — the TYPED face of the per-request store (rfc-server-v3
 * §2.3-2.5, #494).
 *
 * A value derived from the request — a decoded session, an authenticated API
 * client, a request id — computed at most **once per request/render** and
 * shared by every guard, handler and nested in-process call in that flow. The
 * accessor takes `rq`: the ctx-first idiom the parent RFC settled for `rq`
 * itself, with no ambient lookup at the call site.
 *
 * The other face of the same store is `rq.locals`, which stays
 * `Record<string, unknown>` — the escape hatch, for something too small or too
 * transient to name. This is the recommended hand-off: the accessor's return
 * type is inferred from its own setup and the accessor is the only way to reach
 * the value, so there is nothing to cast.
 *
 * Instances live in the store they are keyed by — a slot on `rq.locals` — so
 * there is no new global seam and nothing to key on a source object. What a
 * "request" is therefore follows the store, per transport: the endpoint's
 * context on the wire, the one `{ request, locals }` the scope normalized
 * in-process, the object handed to `.with({ context })`, and per call when
 * nothing supplied either.
 *
 * Disposal (rfc-server-v3 §2.6, phase 5, #571): a setup may register
 * teardown through its second parameter, and the store's OWNER runs the
 * disposers when the request is really over. Ownership is claim-based,
 * first-claimer-wins, per store: the endpoint claims its context before
 * opening a scope (so it owns with or without ALS), `runInScope` claims any
 * unclaimed store it enters (a nested merge reuses the enclosing bag, which
 * is already claimed), and a `.with({ context })`/detached store has NO
 * owner — GC only, with `disposeRequestValues` as the app's own trigger.
 * "Really over" is the owner's settle EXTENDED by any `keepAlive(until)`
 * promises the scope collected — which is how a streamed edge response
 * disposes at end-of-body instead of at the shell (the ALS store outlives
 * `run()`'s settle, so run-settle alone was never a valid trigger there).
 */

import type { ServerFnContext } from './context';

/**
 * `Symbol.for`, not `Symbol()`: in dev the Vite module runner and Node can
 * hold two copies of a module, and a module-local symbol would give a guard
 * and its handler two "shared" stores — the failure being *the guard and the
 * handler saw different sessions*. A registry symbol makes the slot one slot.
 */
const VALUES = Symbol.for('sigx.serverfn.requestValues');

/**
 * The store's disposal record — same registry-symbol reasoning as `VALUES`,
 * and non-enumerable for the same spread/log/serialize hygiene.
 */
const DISPOSAL = Symbol.for('sigx.serverfn.requestDisposal');

/** Parked in the map for the setup's SYNCHRONOUS prefix — see below. */
const RESOLVING = Symbol('sigx.serverfn.resolving');

/** A registered teardown. May be async; its settle is awaited, its throw logged. */
export type PerRequestDispose = () => void | Promise<void>;

interface DisposalState {
    /** LIFO list — a later value may depend on an earlier one. */
    disposers: PerRequestDispose[];
    /** `keepAlive(until)` promises extending the owner's settle. */
    keepAlives: Promise<unknown>[];
    owned: boolean;
    disposed: boolean;
}

function disposalOf(locals: object, create: true): DisposalState;
function disposalOf(locals: object, create: false): DisposalState | undefined;
function disposalOf(locals: object, create: boolean): DisposalState | undefined {
    const bag = locals as Record<symbol, unknown>;
    let state = bag[DISPOSAL] as DisposalState | undefined;
    if (!state && create) {
        state = { disposers: [], keepAlives: [], owned: false, disposed: false };
        Object.defineProperty(bag, DISPOSAL, {
            value: state,
            enumerable: false,
            writable: false,
            configurable: true
        });
    }
    return state;
}

/**
 * Claim disposal ownership of a store. First claimer wins; `false` means
 * someone else already owns it and the caller must NOT dispose. Internal —
 * the endpoint and the scope are the only claimers.
 */
export function claimDisposalOwnership(locals: object): boolean {
    const state = disposalOf(locals, true);
    if (state.owned) return false;
    state.owned = true;
    // A claim BEGINS a request: a deliberately reused bag (the pre-seed
    // recipe across sequential renders) leaves the previous request's
    // `disposed` mark behind, and the new owner starts clean. Between a
    // disposal and the next claim the mark stays sticky, so a straggler
    // from the dead request (a fetcher settling after a client cancel)
    // registers into the run-immediately branch instead of parking forever.
    if (state.disposed) {
        state.disposed = false;
        // The same straggler may have REPOPULATED the memo after disposal
        // cleared it (accessors happily memoize onto a disposed store) —
        // a value the dead request computed must not leak into this one.
        ((locals as Record<symbol, unknown>)[VALUES] as Map<object, unknown> | undefined)?.clear();
    }
    return true;
}

/**
 * Extend the owner's settle: disposal waits for `until` too. Internal — the
 * scope's `keepAlive` seam method lands here.
 */
export function addScopeKeepAlive(locals: object, until: Promise<unknown>): void {
    const state = disposalOf(locals, true);
    if (state.disposed) {
        if (__DEV__) {
            console.warn(
                '[sigx server] keepAlive(until) arrived after this request store was already ' +
                'disposed — ignored. Register it before the scope settles.'
            );
        }
        return;
    }
    state.keepAlives.push(until);
}

/**
 * The owner's fire-and-forget settle hook: await the work's settle, drain
 * every `keepAlive` promise (a keepAlive registered while awaiting another
 * is honored — the loop re-checks), then dispose. Its own catch — this side
 * channel must never surface as an unhandled rejection or perturb the
 * work's own result. Internal.
 */
export function settleAndDispose(locals: object, settled: Promise<unknown>): void {
    void (async () => {
        await settled.then(
            () => undefined,
            () => undefined
        );
        const state = disposalOf(locals, false);
        if (state) {
            while (state.keepAlives.length > 0) {
                await Promise.allSettled(state.keepAlives.splice(0));
            }
        }
        await disposeRequestValues({ locals: locals as Record<string, unknown> });
    })().catch(() => {});
}

/**
 * Run and drain this request store's disposers — LIFO, each awaited, a throw
 * logged in dev and never propagated — and clear the memo map, so a reused
 * store recomputes its setups. Idempotent; a second call is a no-op.
 *
 * PUBLIC, deliberately: a store with no owner — a context handed to
 * `fn.with({ context })`, a detached call — is disposed by whoever owns
 * that context, and this is their trigger.
 */
export async function disposeRequestValues(rq: Pick<ServerFnContext, 'locals'>): Promise<void> {
    const locals = rq.locals as object;
    // ALWAYS materialize the record: marking `disposed` must not depend on a
    // disposer having been registered earlier — a late `onDispose` arriving
    // after a disposer-less disposal still belongs in the run-immediately
    // branch, not parked on a fresh-looking store.
    const state = disposalOf(locals, true);
    const values = (locals as Record<symbol, unknown>)[VALUES] as
        | Map<object, unknown>
        | undefined;
    if (state.disposed) return;
    state.disposed = true;
    // LIFO: a later value may hold a resource derived from an earlier
    // one (a github client over a session), so teardown unwinds.
    for (let i = state.disposers.length - 1; i >= 0; i--) {
        try {
            await state.disposers[i]();
        } catch (error) {
            if (__DEV__) {
                console.warn('[sigx server] a per-request disposer threw (ignored):', error);
            }
        }
    }
    state.disposers.length = 0;
    // Disposal ENDS the request: release ownership so the next scope
    // entry over a deliberately reused bag claims afresh. `disposed`
    // stays sticky until that claim — see claimDisposalOwnership.
    state.owned = false;
    // The request is over: clear the memo so a deliberately reused locals
    // bag recomputes rather than serving a disposed value.
    values?.clear();
}

/** A settled cell: what the setup returned, or what it threw. */
type Cell = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

type ValueStore = Map<object, Cell | typeof RESOLVING>;

/**
 * This request's store, created on first touch and hidden from enumeration.
 *
 * `rq.locals` is a user-facing bag apps spread, log and serialize, and object
 * spread copies own enumerable SYMBOL keys too — so a symbol key alone would
 * not keep this out of `{ ...rq.locals }`. Non-enumerable leaves `Object.keys`,
 * spreads and `JSON.stringify` exactly as clean as they were.
 */
function storeOf(rq: ServerFnContext): ValueStore {
    const locals = rq.locals as Record<symbol, unknown>;
    let store = locals[VALUES] as ValueStore | undefined;
    if (!store) {
        store = new Map();
        Object.defineProperty(locals, VALUES, {
            value: store,
            enumerable: false,
            writable: false,
            configurable: true
        });
    }
    return store;
}

/**
 * Declare a per-request value. Returns the accessor — the only way to reach
 * it.
 *
 * ```ts
 * // src/session.server.ts
 * export const session = perRequest(async (rq) =>
 *     decodeSession(rq.request.headers.get('cookie')));
 *
 * export const github = perRequest(async (rq) => {
 *     const s = await session(rq);                 // the SAME memoized promise
 *     if (!s) throw new ServerFnError(401, 'Sign in');
 *     return createGitHubClient(s.token);
 * });
 *
 * // src/guards.ts
 * export const requireUser: ServerFnGuard = async (rq) => {
 *     if (!(await session(rq))) throw new ServerFnError(401, 'Sign in');
 * };
 * ```
 *
 * Values compose by calling each other, with no composition API at all — which
 * is the whole of what the rejected two-lifetime design needed a resolution
 * graph, a captive-dependency rule and a throwing `rq` getter to express.
 *
 * The setup's second parameter registers teardown (§2.6, phase 5):
 *
 * ```ts
 * export const db = perRequest((rq, onDispose) => {
 *     const conn = pool.acquire();
 *     onDispose(() => conn.release());     // SYNCHRONOUSLY, before any await
 *     return conn;
 * });
 * ```
 *
 * Rules, pinned by tests: register during the setup's SYNCHRONOUS prefix (a
 * later registration still registers, with a dev warning — a warned leak
 * beats a silent one; after disposal it runs immediately instead).
 * Disposers run LIFO when the store's owner settles — response fully
 * flushed, streams included — each awaited, throws logged and swallowed. On
 * a store with NO owner (`fn.with({ context })`, detached calls) nothing
 * runs them automatically: dev warns, and `disposeRequestValues(rq)` is the
 * app's own trigger.
 */
export function perRequest<T>(
    setup: (rq: ServerFnContext, onDispose: (dispose: PerRequestDispose) => void) => T
): (rq: ServerFnContext) => T {
    // Identity is the ACCESSOR, not the setup: `perRequest(fn)` called twice
    // is two independent values, and re-exporting one accessor is one value.
    const token: object = {};
    // Two strings, because they read in different places: `label` identifies
    // the value in prose, `hint` has to be pasteable code — an anonymous setup
    // would otherwise produce "call it as request value(rq)".
    const label = setup.name || 'this request value';
    const hint = setup.name || 'value';

    return function perRequestValue(rq: ServerFnContext): T {
        if (__DEV__ && (rq === null || typeof rq !== 'object' || typeof rq.locals !== 'object')) {
            throw new Error(
                `[sigx server] ${label} was called without a request context — call it as ` +
                `${hint}(rq), with the \`rq\` your server function, guard or handler received ` +
                `(rfc-server-v3 §2.3).`
            );
        }
        const store = storeOf(rq);
        const cell = store.get(token);
        if (cell !== undefined) {
            if (cell === RESOLVING) {
                throw new Error(
                    `[sigx server] circular request value: the setup for ${label} called its ` +
                    `own accessor before it returned. A value cannot derive from itself — move ` +
                    `the shared part into a third value that both call.`
                );
            }
            // Memoized including the REJECTION: a failed decode stays failed
            // for this request. Retrying it once per cell would be a footgun,
            // not a feature. An async setup memoizes its PROMISE, so a guard
            // and a handler racing on first touch share one in-flight decode —
            // there is never a second code path.
            if (!cell.ok) throw cell.error;
            return cell.value as T;
        }
        // Re-entrancy detection covers the setup's SYNCHRONOUS prefix, which is
        // the only window in which nothing is memoized yet. After the first
        // `await` the promise IS the memo, so a self-call there gets that
        // promise back and a genuine cycle is an await on itself; detecting
        // that would need per-value caller tracking, and half-detecting it
        // would make the legitimate guard/handler race throw.
        store.set(token, RESOLVING);
        // The registrar is armed for the setup's synchronous prefix only —
        // the window where "before the response settles" is structurally
        // guaranteed. A later call still registers (a warned leak beats a
        // silent one), and one after disposal runs immediately.
        let armed = true;
        const onDispose = (dispose: PerRequestDispose): void => {
            const state = disposalOf(rq.locals as object, true);
            if (state.disposed) {
                if (__DEV__) {
                    console.warn(
                        `[sigx server] ${label} registered a disposer after its request store ` +
                        `was already disposed — running it immediately.`
                    );
                }
                void Promise.resolve()
                    .then(dispose)
                    .catch((error: unknown) => {
                        if (__DEV__) {
                            console.warn('[sigx server] a per-request disposer threw (ignored):', error);
                        }
                    });
                return;
            }
            if (__DEV__ && !armed) {
                console.warn(
                    `[sigx server] ${label} registered a disposer after its setup's ` +
                    `synchronous prefix — registration this late can race the response's ` +
                    `settle. Register before the first await (rfc-server-v3 §2.6).`
                );
            }
            if (__DEV__ && !state.owned) {
                console.warn(
                    `[sigx server] ${label} registered a disposer on a request store with no ` +
                    `owner — a context handed to fn.with({ context }) or a detached call. ` +
                    `Nothing will run it automatically; call disposeRequestValues(rq) when ` +
                    `your request is over (rfc-server-v3 §2.6).`
                );
            }
            state.disposers.push(dispose);
        };
        let value: T;
        try {
            value = setup(rq, onDispose);
        } catch (error) {
            // Sticky for a SYNC throw too — same rule as a rejection, and it
            // clears RESOLVING so the next caller sees the real error instead
            // of a misleading "circular request value".
            store.set(token, { ok: false, error });
            throw error;
        } finally {
            armed = false;
        }
        store.set(token, { ok: true, value });
        return value;
    };
}
