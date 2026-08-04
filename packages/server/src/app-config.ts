/**
 * The app-wide server pipeline — resolution side (rfc-server-v4 §2).
 *
 * `createServerApp()` (the `./server` entry, phase 2) stamps the app's
 * config on `globalThis.__SIGX_SERVER_APP__`; this module is the ONE
 * accessor, consulted lazily per call by the endpoint and by `invoke`. It is
 * compiled into more than one dist entry, which is safe for the same reason
 * `__SIGX_SERVERFN_CONTEXT__` is (`context.ts`): the state lives on
 * `globalThis`, never in module scope, so the dev dual-module-graph hazard
 * cannot split it.
 *
 * This is the registry's first FAIL-CLOSED control seam (`docs/seams.md`):
 * the accessor never throws on a miss — it returns `undefined`, and each
 * reader maps absence to its layer's deny. Middleware absent → empty chain
 * (degraded observability, not a security property). Authenticator absent →
 * the principal is `null`, so the identity gate denies everything not
 * `allowAnonymous`. Default policy absent → `requireAuthenticated`. The
 * invariant: **a miss may only ever remove permission, never add it.**
 */

import type { ServerFnContext } from './context';
import { ServerFnError } from './errors';
import type { ServerFnInfo, ServerMiddleware, ServerPolicy, ServerPolicyOp } from './types';

/** What `createServerApp` stamps — the pipeline third of its options. */
export interface ServerAppConfig {
    middleware?: readonly ServerMiddleware[];
    authenticate?: (rq: ServerFnContext) => unknown | Promise<unknown>;
    authorize?: ServerPolicy | readonly ServerPolicy[];
}

/** The seam, typed at the single accessor (`docs/seams.md` rule 2). */
type ServerAppSeam = { __SIGX_SERVER_APP__?: ServerAppConfig };

/** The only reader. A miss is `undefined`; every caller fails closed on it. */
export function resolveServerAppConfig(): ServerAppConfig | undefined {
    return (globalThis as ServerAppSeam).__SIGX_SERVER_APP__;
}

/**
 * The only writer (via `createServerApp` and `/testing`'s `stubServerApp`).
 * Last-wins, never a throw: dev HMR re-evaluates the app module, and a
 * re-evaluation is indistinguishable from a second app — the process is the
 * unit, the `__SIGX_SERVERFN_CODEC__` posture. Returns the previous value so
 * a test stamp can restore it.
 */
export function stampServerAppConfig(
    config: ServerAppConfig | undefined
): ServerAppConfig | undefined {
    const seam = globalThis as ServerAppSeam;
    const previous = seam.__SIGX_SERVER_APP__;
    if (config === undefined) {
        delete seam.__SIGX_SERVER_APP__;
    } else {
        seam.__SIGX_SERVER_APP__ = config;
    }
    return previous;
}

/**
 * The principal memo slot on `rq.locals` — `Symbol.for` and non-enumerable,
 * the exact `perRequest` discipline (`per-request.ts`): the request store is
 * held by `locals` identity, a registry symbol makes the slot one slot
 * across module copies, and non-enumerable keeps spreads/logs/scope merges
 * clean. The memo holds the PROMISE, so racing first touches share one
 * resolution and a rejection is sticky for the request — an authenticator
 * runs at most once per request store.
 */
const PRINCIPAL = Symbol.for('sigx.serverfn.principal');

function principalSlot(locals: object): { value?: Promise<unknown> } {
    const bag = locals as Record<symbol, { value?: Promise<unknown> } | undefined>;
    let slot = bag[PRINCIPAL];
    if (!slot) {
        slot = {};
        Object.defineProperty(bag, PRINCIPAL, {
            value: slot,
            enumerable: false,
            writable: false,
            configurable: true
        });
    }
    return slot;
}

/**
 * Resolve the request's principal — the app's `authenticate`, memoized once
 * per request store. No authenticator configured means `null` (anonymous):
 * the miss removes permission at the identity gate, it never grants.
 *
 * A THROW from an authenticator is an infrastructure failure and propagates
 * (masked 500 on the wire) — a bad cookie is `null`, a broken session store
 * is an error. The rejection is sticky for the request, like `perRequest`.
 */
function resolvePrincipal(rq: ServerFnContext): Promise<unknown> {
    const slot = principalSlot(rq.locals);
    if (slot.value) return slot.value;
    const authenticate = resolveServerAppConfig()?.authenticate;
    slot.value = authenticate
        ? Promise.resolve().then(() => authenticate(rq)).then((p) => p ?? null)
        : Promise.resolve(null);
    return slot.value;
}

/**
 * The authenticated principal for this request — `null` when anonymous or
 * when no server app is installed. Runs the app's `authenticate` at most
 * once per request store; inside a handler this is always a memo hit (the
 * pipeline resolved it before the handler ran).
 */
export function principal<P = unknown>(rq: ServerFnContext): Promise<P | null> {
    return resolvePrincipal(rq) as Promise<P | null>;
}

/**
 * The narrowing accessor (rfc-server-v3 §2.8's "throwing accessor, paid once
 * per app", supplied by the framework): the principal, or a
 * `ServerFnError(401)`. Inside a non-`allowAnonymous` handler the throw is
 * unreachable — the identity gate already ran — so this is how a handler
 * gets the non-null type without a cast.
 */
export async function requirePrincipal<P = unknown>(rq: ServerFnContext): Promise<P> {
    const p = await resolvePrincipal(rq);
    if (p === null) throw authenticationRequired();
    return p as P;
}

/**
 * Seed the principal memo, so `authenticate` never runs for this request
 * store: the untyped write for tests (`createTestServerFnContext`'s
 * `principal` option lands here), SSR pre-seeds, and `@sigx/actors`'
 * callee-side hop propagation (rfc-server-v4 §7). Overwrites an existing
 * memo — a deliberately reused store starts the new identity cleanly.
 */
export function setPrincipal(rq: Pick<ServerFnContext, 'locals'>, principal: unknown): void {
    const slot = principalSlot(rq.locals);
    (slot as { value?: Promise<unknown> }).value = Promise.resolve(principal ?? null);
}

/**
 * The built-in default policy: any authenticated caller. It is the effective
 * policy wherever neither the definition nor the app declared one, and since
 * the identity gate runs first it only ever sees a non-null principal — the
 * default can never be the thing that admits an anonymous caller
 * (rfc-server-v4 §1.3: anonymity is granted only by the per-fn literal).
 */
export const requireAuthenticated: ServerPolicy = (principal) => principal !== null;

function authenticationRequired(): ServerFnError {
    return new ServerFnError(401, 'Authentication required');
}

/** Latch for the once-per-process unconfigured-deny hint. */
let hintedUnconfigured = false;

/**
 * Steps 1–3 of the pipeline (rfc-server-v4 §1.3): app middleware, in
 * declared order → authenticate (memoized) → the identity gate. A wire
 * transport runs this BEFORE decoding arguments (`reviveWire` — the #559
 * invariant: nothing does attacker-directed work before the request is
 * vetted, and now anonymous payloads never reach the codec or the validator
 * either); `invoke` runs it itself for in-process calls.
 */
export async function runServerPrelude(
    rq: ServerFnContext,
    info: ServerFnInfo,
    allowAnonymous: boolean
): Promise<void> {
    const config = resolveServerAppConfig();
    if (config?.middleware) {
        for (const middleware of config.middleware) await middleware(rq, info);
    }
    const p = await resolvePrincipal(rq);
    if (p === null && !allowAnonymous) {
        if (__DEV__ && !hintedUnconfigured && config === undefined) {
            hintedUnconfigured = true;
            console.warn(
                `[sigx server] denying "${info.name || info.symbol}" — no server app is ` +
                `configured in this process, so every function not declaring ` +
                `\`allowAnonymous: true\` denies (rfc-server-v4 §2.1, fail-closed). ` +
                `Configure one with createServerApp({ authenticate, … }) — or, in a unit ` +
                `test, inject an identity: createTestServerFnContext(init, { principal }) ` +
                `from '@sigx/server/testing'. Fires once per process.`
            );
        }
        throw authenticationRequired();
    }
}

/**
 * Step 6 — authorization, phase B (rfc-server-v4 §1.3): runs after `input`
 * validation, immediately before the handler, with the principal and the
 * validated input. The effective chain is the definition's `authorize` if
 * declared (most-specific-wins), else the app default, else
 * `requireAuthenticated` — except that a bare `allowAnonymous` definition
 * declares "no requirement" and skips the defaults entirely (they would
 * re-deny the anonymity the literal granted).
 *
 * STRICT-`true`: any other result denies — a forgotten return fails closed.
 */
export async function runAuthorize(
    rq: ServerFnContext,
    op: ServerPolicyOp,
    declared: ServerPolicy | readonly ServerPolicy[] | undefined,
    allowAnonymous: boolean
): Promise<void> {
    let effective: ServerPolicy | readonly ServerPolicy[] | undefined = declared;
    if (effective === undefined) {
        if (allowAnonymous) return;
        effective = resolveServerAppConfig()?.authorize ?? requireAuthenticated;
    }
    const p = (await resolvePrincipal(rq)) ?? null;
    const policies = Array.isArray(effective) ? effective : [effective as ServerPolicy];
    for (const policy of policies) {
        if ((await policy(p, rq, op)) !== true) {
            throw p === null
                ? authenticationRequired()
                : new ServerFnError(403, 'Forbidden');
        }
    }
}
