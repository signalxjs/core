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

import { createRequestContext, type ServerFnContext } from './context';
import { ServerFnError } from './errors';
import { fnPathPrefix } from './fn-url-decode';
import type {
    EndpointPosture,
    ServerFeatureContext,
    ServerFeatureOp,
    ServerFnInfo,
    ServerMiddleware,
    ServerPolicy,
    ServerPolicyOp
} from './types';

/** What `createServerApp` stamps — pipeline, posture, and the codec. */
export interface ServerAppConfig {
    middleware?: readonly ServerMiddleware[];
    authenticate?: (rq: ServerFnContext) => unknown | Promise<unknown>;
    authorize?: ServerPolicy | readonly ServerPolicy[];
    /**
     * The app's endpoint posture (rfc-server-v4 §3.1) — consulted by
     * `handleServerFnRequest` for any wire knob the call's own options
     * leave undefined (explicit wins; the built-in default is last).
     */
    posture?: EndpointPosture;
    /**
     * Round-trips a principal as a string — the cross-hop propagation
     * contract `@sigx/actors` consumes (rfc-server-v4 §7). Core stores it;
     * it plays no role in this package's own pipeline.
     */
    codec?: { encode(principal: unknown): string; decode(encoded: string): unknown | null };
    /**
     * Base prefixes this app's mounts have claimed (#543 — everything after
     * the base IS the symbol, so two families cannot share one). Lives on
     * the config rather than in `createServerApp`'s closure so the promoted
     * feature seam (#625) can claim without an app handle, while keeping
     * the scope per-APP: stamping a new app brings a fresh array, which is
     * what lets a test suite build many apps over one process.
     */
    claimedBases?: string[];
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
 *
 * The config is FROZEN on the way in. Replacing the app wholesale stays
 * legal (HMR needs it) and already dev-warns at `createServerApp`; swapping
 * a member in place — `globalThis.__SIGX_SERVER_APP__.authorize = () => true`
 * — did not warn and silently failed OPEN, which is exactly what this seam's
 * fail-closed class forbids (`docs/seams.md`). Now it throws. `claimedBases`
 * is pre-seeded first because `claimAppBase` does `??=` on it and freeze is
 * shallow: with the array present that assignment short-circuits and never
 * writes, while `push` on the array keeps working.
 *
 * The property itself is defined NON-ENUMERABLE: this seam is pack-internal
 * wiring, not a payload anything reads off `globalThis` by hand, so it has
 * no business in `Object.keys(globalThis)` or a console completion list.
 * `writable`/`configurable` keep last-wins re-stamping and `dispose()`'s
 * delete working.
 */
export function stampServerAppConfig(
    config: ServerAppConfig | undefined
): ServerAppConfig | undefined {
    const seam = globalThis as ServerAppSeam;
    const previous = seam.__SIGX_SERVER_APP__;
    if (config === undefined) {
        delete seam.__SIGX_SERVER_APP__;
        return previous;
    }
    // Guarded, not unconditional: a restore stamp (`stubServerApp`'s teardown)
    // hands back a config this function already froze, and `??=` on a frozen
    // object with the key absent would throw.
    if (!Object.isFrozen(config)) {
        config.claimedBases ??= [];
        Object.freeze(config);
    }
    Object.defineProperty(seam, '__SIGX_SERVER_APP__', {
        value: config,
        writable: true,
        configurable: true
    });
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

/**
 * Latch for the once-per-process unconfigured-deny hint — on `globalThis`
 * under a registry symbol, not module-local: in dev the module runner and
 * Node can hold two copies of this module (the `context.ts:56-65` hazard),
 * and a module-local latch would fire the "once per process" hint once per
 * copy, contradicting its own message.
 */
const HINTED = Symbol.for('sigx.serverfn.unconfiguredHint');
function hintOnce(): boolean {
    const seam = globalThis as Record<symbol, boolean | undefined>;
    if (seam[HINTED]) return false;
    seam[HINTED] = true;
    return true;
}

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
        if (__DEV__ && config === undefined && hintOnce()) {
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

/**
 * Claim a mount's base prefix on an app's registry (#543). Exported so
 * `createServerApp` and the feature seam share ONE implementation — two
 * versions of "do these bases overlap" is how the second family would get a
 * different answer from the first.
 *
 * `config` names WHICH app's registry, and the distinction matters:
 * `createServerApp` passes the config it captured, so `app.serverFns(...)`
 * claims on THAT app even when a later app (dev HMR re-evaluating the
 * server-app module) has since taken the stamp — otherwise a mount on a
 * stale handle would record against the live app and invent or miss an
 * overlap. The feature seam resolves per call instead, because a feature
 * holds its context at module scope and means "the app in force now".
 *
 * A no-op when there is no app: nothing to collide with, and base claiming
 * is mount-time bookkeeping rather than permission, so the fail-closed rule
 * ("a miss may only remove permission") does not apply to it.
 */
export function claimAppBase(
    base: string,
    config: ServerAppConfig | undefined = resolveServerAppConfig()
): void {
    if (config === undefined) return;
    const prefix = fnPathPrefix(base);
    const claimed = (config.claimedBases ??= []);
    for (const existing of claimed) {
        if (prefix.startsWith(existing) || existing.startsWith(prefix)) {
            // At MOUNT time — boot/CI, never per request.
            throw new Error(
                `[sigx server] mount base "${base}" overlaps an existing mount ` +
                `("${existing}" vs "${prefix}") — every mount needs its own path ` +
                `namespace, because everything after the base IS the symbol (#543).`
            );
        }
    }
    claimed.push(prefix);
}

/**
 * The endpoint-family seam (rfc-server-v4 §3.2, promoted in #625) — see
 * {@link ServerFeatureContext}.
 *
 * Takes no app: every member resolves `__SIGX_SERVER_APP__` per call, so
 * one of these held at module scope always sees the live app, and a
 * feature whose entry points have no platform value in scope (an
 * `@sigx/actors` `actor()` call anywhere in a request) still runs the whole
 * pipeline. `ServerApp.feature()` returns one of these too, for a consumer
 * that does have the app to hand.
 */
export function serverFeature<P = unknown>(): ServerFeatureContext<P> {
    return {
        async enter(request, fn, options) {
            const rq = createRequestContext(request);
            await runServerPrelude(rq, fn, options?.allowAnonymous === true);
            return rq;
        },
        prelude(rq, fn, options) {
            return runServerPrelude(rq, fn, options?.allowAnonymous === true);
        },
        authorize(rq, op: ServerFeatureOp<P>) {
            return runAuthorize(
                rq,
                {
                    fn: op.fn,
                    ...(op.input !== undefined ? { input: op.input } : {}),
                    args: op.args ?? [],
                    ...(op.resource !== undefined ? { resource: op.resource } : {})
                },
                op.policies as ServerPolicy | readonly ServerPolicy[] | undefined,
                op.allowAnonymous === true
            );
        },
        get posture(): Readonly<EndpointPosture> {
            return resolveServerAppConfig()?.posture ?? {};
        },
        get principalCodec() {
            return resolveServerAppConfig()?.codec;
        },
        claimBase: claimAppBase
    };
}
