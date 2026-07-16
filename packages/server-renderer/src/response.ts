/**
 * useResponse — the per-request response seam (rfc-ssr-platform §2.1).
 *
 * Components signal status / redirect / headers during the server render;
 * the values collect on the per-request SSRContext (like head) and surface
 * on the document shell promise, so the HTTP layer decides before the first
 * byte:
 *
 * ```tsx
 * const NotFound = component(() => {
 *     useResponse().status(404);
 *     return () => <h1>Not found</h1>;
 * });
 *
 * const guard = component(() => {
 *     if (!loggedIn) useResponse().redirect('/login', 302);
 *     return () => <Dashboard />;
 * });
 * ```
 *
 * On the client (and outside a server render) the returned object is inert —
 * calls are no-ops, so shared components need no environment branching. The
 * seam is router-agnostic: the router SSR contract (§3.2) feeds it, but any
 * component can.
 */

import { getCurrentInstance } from 'sigx/internals';
import type { SSRContext } from './server/context';

/** The chainable per-request response recorder returned by useResponse(). */
export interface ResponseRecorder {
    /** Set the HTTP status code for this request. Last write wins. */
    status(code: number): ResponseRecorder;
    /**
     * Redirect the request. Short-circuits a streaming document: the shell
     * promise resolves with the redirect and no body bytes are produced.
     * Default status: 302.
     */
    redirect(location: string, status?: number): ResponseRecorder;
    /** Set a response header. Last write per name wins (names lowercased). */
    header(name: string, value: string): ResponseRecorder;
}

/** Response state collected on the SSRContext during one request. */
export interface ResponseState {
    status?: number;
    headers: Record<string, string>;
    redirect?: { location: string; status: number };
}

/**
 * The shell-promise resolution value: everything the HTTP layer needs to
 * write the response head before piping the body.
 */
export interface SSRResponse {
    /** Explicit status, else the redirect status, else 200. */
    status: number;
    /** Collected headers (names lowercased). */
    headers: Record<string, string>;
    /** Present when the render requested a redirect — send it, skip the body. */
    redirect?: { location: string; status: number };
}

const INERT: ResponseRecorder = {
    status() { return INERT; },
    redirect() { return INERT; },
    header() { return INERT; }
};

function recorderFor(ctx: SSRContext): ResponseRecorder {
    const recorder: ResponseRecorder = {
        status(code: number) {
            ctx._response.status = code;
            return recorder;
        },
        redirect(location: string, status = 302) {
            ctx._response.redirect = { location, status };
            return recorder;
        },
        header(name: string, value: string) {
            ctx._response.headers[name.toLowerCase()] = value;
            return recorder;
        }
    };
    return recorder;
}

/**
 * Access the per-request response recorder. Call synchronously during setup
 * (like useHead). Inert outside a server render.
 */
export function useResponse(): ResponseRecorder {
    const instance = getCurrentInstance() as any;
    // The server walk installs `ssr._ctx` (the per-request render context)
    // on the component instance — record there. Safe under concurrent
    // renders; no module-level state.
    const ssrCtx = instance?.ssr?.isServer ? (instance.ssr._ctx as SSRContext) : null;
    return ssrCtx ? recorderFor(ssrCtx) : INERT;
}

/** Snapshot a request's collected response state as the shell resolution value. */
export function responseSummary(ctx: SSRContext): SSRResponse {
    const { status, headers, redirect } = ctx._response;
    return {
        status: status ?? redirect?.status ?? 200,
        headers: { ...headers },
        ...(redirect ? { redirect: { ...redirect } } : {})
    };
}
