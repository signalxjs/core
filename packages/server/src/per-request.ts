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
 * There is **no disposal** in v1, deliberately: `createFetchHandler` settles
 * its scope at the shell, so "disposed when the response has fully flushed"
 * would fire mid-stream on every edge deploy (§2.6). Until that ships, an app
 * that needs teardown owns it in its own handler, where it already has the
 * request.
 */

import type { ServerFnContext } from './context';

/**
 * `Symbol.for`, not `Symbol()`: in dev the Vite module runner and Node can
 * hold two copies of a module, and a module-local symbol would give a guard
 * and its handler two "shared" stores — the failure being *the guard and the
 * handler saw different sessions*. A registry symbol makes the slot one slot.
 */
const VALUES = Symbol.for('sigx.serverfn.requestValues');

/** Parked in the map for the setup's SYNCHRONOUS prefix — see below. */
const RESOLVING = Symbol('sigx.serverfn.resolving');

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
 */
export function perRequest<T>(setup: (rq: ServerFnContext) => T): (rq: ServerFnContext) => T {
    // Identity is the ACCESSOR, not the setup: `perRequest(fn)` called twice
    // is two independent values, and re-exporting one accessor is one value.
    const token: object = {};
    const label = setup.name || 'request value';

    return function perRequestValue(rq: ServerFnContext): T {
        if (__DEV__ && (rq === null || typeof rq !== 'object' || typeof rq.locals !== 'object')) {
            throw new Error(
                `[sigx server] the per-request value "${label}" was called without a request ` +
                `context — call it as ${label}(rq), with the \`rq\` your server function, guard ` +
                `or handler received (rfc-server-v3 §2.3).`
            );
        }
        const store = storeOf(rq);
        const cell = store.get(token);
        if (cell !== undefined) {
            if (cell === RESOLVING) {
                throw new Error(
                    `[sigx server] circular request value: the setup for "${label}" called its ` +
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
        let value: T;
        try {
            value = setup(rq);
        } catch (error) {
            // Sticky for a SYNC throw too — same rule as a rejection, and it
            // clears RESOLVING so the next caller sees the real error instead
            // of a misleading "circular request value".
            store.set(token, { ok: false, error });
            throw error;
        }
        store.set(token, { ok: true, value });
        return value;
    };
}
