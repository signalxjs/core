/**
 * ServerFnContext — the explicit request context every server function
 * receives as its FIRST parameter (rfc-server §2). No `this`, no ambient
 * global: explicit beats ambient, and it makes the in-process SSR call
 * semantics obvious.
 */

/** Request context — first parameter of every server function. */
export interface ServerFnContext {
    /** The WinterCG request (request headers live on `request.headers`). */
    request: Request;
    /** Parsed request URL. */
    url: URL;
    /** Fires when the client disconnects. (Named `abortSignal` so it can
     *  never be confused with sigx's reactive signals — `ctx.signal` is a
     *  different world; the platform-named twin stays at
     *  `rq.request.signal`.) */
    abortSignal: AbortSignal;
    /** Mutable RESPONSE headers, applied before the body is written. */
    responseHeaders: Headers;
    /** Override the success status code (errors carry their own). */
    status(code: number): void;
    /** Guard/middleware hand-off (auth results etc.). */
    locals: Record<string, unknown>;
}

/** Internal view: the HTTP handler reads the status override back out. */
export interface InternalServerFnContext extends ServerFnContext {
    _status?: number;
    /** The options form's VALIDATED input, stashed per-request so the
     *  endpoint feeds `invalidates` exactly what the handler saw (§6.2). */
    _input?: unknown;
}

/** Build the live context for one HTTP invocation. */
export function createRequestContext(request: Request): InternalServerFnContext {
    const ctx: InternalServerFnContext = {
        request,
        url: new URL(request.url),
        abortSignal: request.signal,
        responseHeaders: new Headers(),
        status(code: number) {
            ctx._status = code;
        },
        locals: {}
    };
    return ctx;
}

/**
 * Never-aborting signal shared by every detached context — created LAZILY:
 * workerd forbids `new AbortController()` in module global scope (no request
 * context), and this module lands in the bundled worker graph (rfc-deploy).
 * First use always happens inside a handler, where it is allowed.
 */
let _detachedSignal: AbortSignal | undefined;
function detachedSignal(): AbortSignal {
    return (_detachedSignal ??= new AbortController().signal);
}

/**
 * The v1 context for IN-PROCESS calls (a server function invoked during SSR
 * or from other server code — no HTTP hop, rfc-server §7). `request`/`url`
 * throw a descriptive error; `responseHeaders`/`status()` are inert. The
 * ambient-request upgrade (AsyncLocalStorage) is the designed v1.1
 * follow-up.
 */
export function createDetachedContext(): ServerFnContext {
    const noRequest = (what: string): never => {
        throw new Error(
            `[sigx server] ${what} is not available on an in-process server-function call — ` +
            `there is no HTTP request. (Reading the live request during SSR is the designed ` +
            `v1.1 follow-up; see docs/rfc-server.md §7.)`
        );
    };
    return {
        get request(): Request {
            return noRequest('rq.request');
        },
        get url(): URL {
            return noRequest('rq.url');
        },
        get abortSignal(): AbortSignal {
            return detachedSignal();
        },
        responseHeaders: new Headers(),
        status(code: number) {
            if (__DEV__) {
                console.warn(
                    `[sigx server] rq.status(${code}) is inert on an in-process server-function ` +
                    `call — there is no HTTP response to affect.`
                );
            }
        },
        locals: {}
    };
}
