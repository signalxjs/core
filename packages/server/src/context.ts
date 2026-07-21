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
 * What an in-process caller can hand in as the request context — either a
 * bare `Request` (the common case) or a partial context to override more.
 */
export type ServerFnContextInit = Request | Partial<ServerFnContext>;

/**
 * The ambient-context seam (`docs/seams.md`). `@sigx/server/node`'s
 * `runWithServerFnContext` stamps a resolver here; this module reads it.
 *
 * A GLOBAL rather than a module-level variable on purpose: the `.` and
 * `./node` entries are separate dist entries, and in dev the Vite module
 * runner and Node can hold two copies of the same module — the same hazard
 * that makes `ServerFnError` a brand check rather than `instanceof`. A
 * module-local resolver would be set on one copy and read from the other.
 */
function ambientContext(): ServerFnContextInit | undefined {
    const resolve = (globalThis as {
        __SIGX_SERVERFN_CONTEXT__?: () => ServerFnContextInit | undefined;
    }).__SIGX_SERVERFN_CONTEXT__;
    if (!resolve) return undefined;
    try {
        return resolve();
    } catch {
        // A broken ambient provider must not break an otherwise valid call;
        // the detached context's descriptive throw is the better failure.
        return undefined;
    }
}

/**
 * Build a live-ish context from what an in-process caller supplied.
 * `responseHeaders`/`status()` stay inert: there is no HTTP response to
 * affect, and pretending otherwise would silently drop headers.
 */
function contextFrom(init: ServerFnContextInit, signal?: AbortSignal): ServerFnContext {
    const partial: Partial<ServerFnContext> =
        init instanceof Request ? { request: init } : init;
    const request = partial.request;
    const url = partial.url ?? (request ? new URL(request.url) : undefined);
    const detached = createDetachedContext(signal);
    // Built explicitly rather than spreading `detached`: object spread READS
    // every enumerable property, which would invoke its throwing
    // `request`/`url` getters at construction time. The getters below fall
    // through to those same throws only when the caller supplied neither —
    // a partial context still gets the descriptive error for what is missing.
    return {
        get request(): Request {
            return request ?? detached.request;
        },
        get url(): URL {
            return url ?? detached.url;
        },
        abortSignal: signal ?? partial.abortSignal ?? detached.abortSignal,
        responseHeaders: partial.responseHeaders ?? new Headers(),
        status: partial.status ?? detached.status,
        locals: partial.locals ?? {}
    };
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
 * The context for an IN-PROCESS call — a server function invoked during SSR
 * or from other server code, with no HTTP hop (rfc-server §7).
 *
 * Resolution order, most explicit first:
 *
 *   1. `fn.with({ context })`  — the caller handed one in (#352)
 *   2. ambient  — `runWithServerFnContext` is on the stack (#309)
 *   3. detached — `request`/`url` throw a descriptive error
 *
 * The throw stays the default deliberately: a server function reading
 * `rq.request` when nothing supplied one is a bug the author should see,
 * not a silent undefined.
 */
export function resolveInProcessContext(
    signal?: AbortSignal,
    explicit?: ServerFnContextInit
): ServerFnContext {
    const init = explicit ?? ambientContext();
    return init ? contextFrom(init, signal) : createDetachedContext(signal);
}

/**
 * The fully detached context: `request`/`url` throw a descriptive error and
 * `responseHeaders`/`status()` are inert. Used when neither an explicit nor
 * an ambient context is available.
 */
export function createDetachedContext(signal?: AbortSignal): ServerFnContext {
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
            // Per-call signal (fn.with({ signal })) or the shared
            // never-aborting default.
            return signal ?? detachedSignal();
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
