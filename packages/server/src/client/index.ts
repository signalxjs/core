/**
 * @sigx/server/client — the fetch stubs the `@sigx/vite/server` transform
 * emits imports of (rfc-server §1.1). DEPENDENCY-FREE by contract: resume
 * handler chunks replicate `import { fn } from './x.server'`, which resolves
 * to a generated stub module importing this entry — it must not drag any
 * runtime along (size-limit checks it with no ignore list).
 *
 * Wire format (rfc-server §4, one route per function since rfc-server-v5
 * §3): `POST {base}/{key}` — the key is `<id>/<name>` and its slashes stay
 * real path separators (`encodeFnPath`, #355) — with
 * `{"args": [input], "v": "<version>"}`; `200 {"data": ...}` back, or
 * `{status} {"error": {message, status, code?, data?}}`. A cache-marked read
 * is `GET {base}/{key}?a0=…&v=<version>`. The version is the build's tag
 * for the function: a 409 `code: 'version-skew'` means this page is a stale
 * build. Errors are re-created with the `__sigxServerFnError` brand so
 * `isServerFnError` matches them.
 */

// Type-only — erased at build, so the entry stays dependency-free.
import type { ServerFnCallOptions, ServerStreamCallOptions } from '../types';
// In-package module (no external dependency): the rfc-server §4 wire codec,
// shared with the `/server` entry. size-limit's esbuild pass follows the
// import, so its bytes still count against this entry's ceiling.
import { encodeWire, reviveWire } from '../wire-codec';
// Ditto: the §4/§4.1 URL grammar (path + read query), shared with the
// `/server` entry (#355).
import { encodeFnPath, encodeReadQuery } from '../fn-url';

/**
 * Reviver DROPS an own `__proto__` key from the parsed value (rfc-server §4)
 * — the one key that is a prototype swap under later assignment/merge.
 * "constructor"/"prototype" are plain data keys and pass through (#560: a
 * server function returning `{ constructor: 'Acme Corp' }` used to lose the
 * field here, silently). `@sigx/serialize`'s revive guards the same key at
 * its own rebuild (#548); this parse-time drop is the belt for response
 * data consumers that never go through the codec.
 */
const reviver = (key: string, value: unknown): unknown => {
    if (key === '__proto__') {
        if (__DEV__) {
            console.warn(
                '[sigx] dropped an own "__proto__" key from a server response ' +
                '(prototype-pollution guard).'
            );
        }
        return undefined;
    }
    return value;
};

interface WireError {
    message?: string;
    status?: number;
    /** Machine-readable discriminator (`'version-skew'`). */
    code?: string;
    data?: unknown;
}

/**
 * Runtime transport config (rfc-server rev 2, N.1) — how a native client
 * (lynx, terminal) or a bearer-auth web SPA points its stubs at a remote
 * backend. Stubs resolve it at CALL time, so one build serves
 * dev/staging/prod and header factories can rotate credentials.
 */
export interface ServerFnTransport {
    /** Absolute URL or path prefix; wins over the build-time endpoint. */
    endpoint?: string;
    /** Extra request headers — static map or (possibly async) factory. */
    headers?:
        | Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>);
    /** Fetch implementation; default is the global fetch. */
    fetch?: typeof globalThis.fetch;
    /**
     * `RequestInit.credentials` for every stub call (rfc-server-v5 §1.8).
     * Unset means the platform default — same-origin cookies ride, a
     * cross-origin `endpoint` sends none; `'include'` opts a remote
     * backend into cookie auth (its CORS must allow credentials).
     */
    credentials?: RequestCredentials;
}

let transport: ServerFnTransport | null = null;

/** Set (or with `null` clear) the transport every stub resolves at call time. */
export function configureServerFn(config: ServerFnTransport | null): void {
    transport = config;
}

/** Send the RPC envelope — POST body, or for a cache-marked read (§4.1) a
 *  GET whose `?args=` carries the same JSON text — resolving the transport
 *  at call time (configureServerFn endpoint > baked endpoint; rfc-server N.1). */
async function send(
    endpoint: string,
    key: string,
    args: unknown[],
    get: boolean,
    version: string,
    options?: ServerFnCallOptions,
    boundaries?: { base: number; refresh: unknown[] }
): Promise<Response> {
    const config = transport;
    const target = config?.endpoint ?? endpoint;
    const prefix = target.endsWith('/') ? target.slice(0, -1) : target;
    const extra =
        typeof config?.headers === 'function' ? await config.headers() : config?.headers;
    // content-type is NOT overridable (the endpoint 415s anything else;
    // rfc-server N.1) — stripped case-insensitively, since Headers
    // normalization would otherwise COMBINE `Content-Type: x` with ours.
    // A GET carries no body and therefore no content-type at all.
    // Per-call headers (#315) merge OVER transport headers — the one-off
    // wins — under the same content-type rule.
    const headers: Record<string, string> = {};
    for (const source of [extra, options?.headers]) {
        for (const key in source) {
            if (key.toLowerCase() !== 'content-type') headers[key] = source[key];
        }
    }
    const signal = options?.signal;
    const credentials = config?.credentials;
    const base = `${prefix}/${encodeFnPath(key)}`;
    let url = base;
    let init: RequestInit;
    if (get) {
        const query = encodeReadQuery(args, (blob) => JSON.stringify(encodeWire(blob)));
        if (__DEV__ && query.length > 2048) {
            console.warn(
                `[sigx server] GET read "${key}" encodes ~${query.length} bytes of ` +
                `arguments into its URL — too large to make a good cache key. Use a ` +
                `smaller input, or keep this read on POST (drop \`cache\`).`
            );
        }
        // `v` rides the query on a read (rfc-server-v5 §3.2): a new deploy is
        // a new HTTP cache key for free. hex8, so it never needs encoding.
        const search = version ? (query ? `${query}&v=${version}` : `v=${version}`) : query;
        url = search ? `${base}?${search}` : base;
        init = {
            method: 'GET',
            headers,
            // §4.1's per-call freshness escape (#315): revalidate with the
            // origin instead of answering from max-age.
            ...(options?.fresh ? { cache: 'no-cache' as RequestCache } : {}),
            ...(signal ? { signal } : {})
        };
    } else {
        if (__DEV__ && options?.fresh) {
            console.warn(
                `[sigx server] .with({ fresh }) is a no-op on "${key}" — only a ` +
                `cache-marked GET read is ever answered from an HTTP cache; POSTs ` +
                `always reach the origin.`
            );
        }
        headers['content-type'] = 'application/json';
        // The §6.3 sidecar is already boundary-codec-encoded table data —
        // attached verbatim, never through encodeWire.
        const envelope: Record<string, unknown> = { args: encodeWire(args) };
        if (version) envelope.v = version;
        if (boundaries) envelope.$boundaries = boundaries;
        init = {
            method: 'POST',
            headers,
            body: JSON.stringify(envelope),
            ...(signal ? { signal } : {})
        };
    }
    if (credentials) init.credentials = credentials;
    // Branch instead of aliasing the global fetch — an unbound alias is
    // an illegal invocation in some runtimes, and the zero-config path
    // must stay byte-identical to a plain `fetch(...)` call.
    return config?.fetch ? config.fetch(url, init) : fetch(url, init);
}

/** Re-create a wire error with the `__sigxServerFnError` brand. `data` is
 *  revived like any payload — a `ServerFnError` may carry rich types too;
 *  `code` (when the endpoint sent one) is what an app branches on. */
function wireFail(status: number, wire: WireError | undefined, message: string): Error {
    return Object.assign(new Error(wire?.message ?? message), {
        __sigxServerFnError: true,
        status: wire?.status ?? status,
        ...(typeof wire?.code === 'string' ? { code: wire.code } : {}),
        data: wire && 'data' in wire ? reviveWire(wire.data) : undefined
    });
}

/** True for the endpoint's 409 `version-skew` (rfc-server-v5 §3.2). */
const isSkew = (status: number, wire: WireError | undefined): boolean =>
    status === 409 && wire?.code === 'version-skew';

/** The message a failed call throws with. Version skew gets the one hint a
 *  user can act on; 404 means only "unknown function" now. */
const failMessage = (name: string, status: number, skew: boolean): string =>
    skew
        ? `server function "${name}" belongs to a different build than this page ` +
          `(version skew); reload to pick up the current one.`
        : status === 404
          ? `server function "${name}" not found (HTTP 404)`
          : `server function "${name}" failed (HTTP ${status})`;

/** Cache directives the server attached to an envelope (rfc-server §6.2). */
export interface ServerFnCacheDirectives {
    /** Patterns for `invalidate()`: canonical strings or tuple prefixes. */
    invalidates?: ReadonlyArray<string | readonly unknown[]>;
}

/**
 * The `__SIGX_SERVERFN_CACHE__` seam's shape at this (reading) end — the
 * stamping end is `@sigx/cache`'s `ServerFnCacheSeam`; `docs/seams.md`
 * carries the canonical contract both copy (no import in either direction).
 */
type ServerFnCacheSeamGlobal = {
    __SIGX_SERVERFN_CACHE__?: (d: ServerFnCacheDirectives) => void;
};

/**
 * Surface `$cache` to the installed cache pack. The seam is a GLOBAL
 * (`__SIGX_SERVERFN_CACHE__`, stamped by `@sigx/cache`'s plugin install) —
 * no import in either direction, the live-client-marker pattern, keeping
 * this entry dependency-free. A hook failure never breaks the RPC result.
 */
function deliverCacheDirectives(directives: ServerFnCacheDirectives): void {
    const hook = (globalThis as ServerFnCacheSeamGlobal).__SIGX_SERVERFN_CACHE__;
    if (!hook) return;
    try {
        hook(directives);
    } catch (error) {
        // Swallowed either way — a cache-pack bug must not break the RPC
        // result; the detail is dev-only, matching the package's posture.
        if (__DEV__) console.error('[sigx server] $cache envelope hook threw:', error);
    }
}

/**
 * The single-flight refresh seam (rfc-server §6.3) — a GLOBAL stamped by
 * `@sigx/resume/client`, same posture as `__SIGX_SERVERFN_CACHE__`:
 * `collect()` inventories the page's refreshable boundaries for the request
 * sidecar; `apply(entries, seq)` patches the response's fresh HTML/state in.
 * `seq` is dispatch order — the pack drops entries an earlier-dispatched but
 * later-arriving call would stale-overwrite with.
 */
export interface BoundaryRefreshSeam {
    collect(): { base: number; refresh: unknown[] } | null | undefined;
    apply(entries: unknown[], seq: number): void;
}

/** The `__SIGX_SERVERFN_BOUNDARIES__` seam's shape at this (reading) end. */
type BoundaryRefreshSeamGlobal = { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam };

let refreshSeq = 0;

function refreshSeam(): BoundaryRefreshSeam | undefined {
    return (globalThis as BoundaryRefreshSeamGlobal).__SIGX_SERVERFN_BOUNDARIES__;
}

/** Bit 0 of a stub's `flags`: a cache-marked GET read (rfc-server §4.1). */
const FLAG_GET = 1;
/** Bit 1: an `invalidates`-declaring mutation (§6.2/§6.3) — the stub sends
 *  the boundary inventory up and applies the envelope's fresh entries. */
const FLAG_INVALIDATES = 2;

/** Create the typed client stub for one extracted server function
 *  (rfc-server-v5 §1.4): `key` is the fn's stable key `<id>/<name>` — the
 *  route AND the `useData(fn)` identity, stamped as `__sigxKey`; `version`
 *  is the build's tag for it, sent with every call; `flags` is a bitmask
 *  (`FLAG_GET` | `FLAG_INVALIDATES`), omitted when zero. */
export function __serverFnStub(
    key: string,
    name: string,
    endpoint: string,
    version: string,
    flags = 0
): ((...args: unknown[]) => Promise<unknown>) & {
    with(options?: ServerFnCallOptions): (...args: unknown[]) => Promise<unknown>;
    __sigxKey: string;
} {
    const get = (flags & FLAG_GET) !== 0;
    const invalidates = (flags & FLAG_INVALIDATES) !== 0;
    const call = async (args: unknown[], options?: ServerFnCallOptions): Promise<unknown> => {
        // §6.3 sidecar — only invalidates-declaring mutations pay the
        // inventory, and only when the pack has stamped the seam. Seam
        // throws are swallowed like the cache hook's: never break the RPC.
        let sidecar: { base: number; refresh: unknown[] } | null | undefined;
        let seq = 0;
        const seam = invalidates && !get ? refreshSeam() : undefined;
        if (seam) {
            try {
                sidecar = seam.collect();
                seq = ++refreshSeq;
            } catch (error) {
                if (__DEV__) console.error('[sigx server] $boundaries collect threw:', error);
            }
        }
        const res = await send(
            endpoint,
            key,
            args,
            get,
            version,
            options,
            sidecar && sidecar.refresh.length > 0 ? sidecar : undefined
        );
        const text = await res.text();
        let payload:
            | { data?: unknown; error?: WireError; $cache?: ServerFnCacheDirectives; $boundaries?: unknown[] }
            | undefined;
        try {
            payload = text ? JSON.parse(text, reviver) : undefined;
        } catch {
            payload = undefined; // non-JSON error body (proxy page, …)
        }
        if (!res.ok) {
            const wire = payload?.error;
            const skew = isSkew(res.status, wire);
            const message = failMessage(name, res.status, skew);
            // The skew hint replaces the endpoint's terse message — it is
            // the one thing a user can act on. Every other error keeps the
            // server's words.
            throw wireFail(res.status, skew ? { ...wire, message } : wire, message);
        }
        if (payload?.$cache) deliverCacheDirectives(payload.$cache);
        if (seam && Array.isArray(payload?.$boundaries)) {
            try {
                seam.apply(payload!.$boundaries!, seq);
            } catch (error) {
                if (__DEV__) console.error('[sigx server] $boundaries apply threw:', error);
            }
        }
        // Revive `data` specifically, not the whole envelope: `$cache` and
        // `$boundaries` are reserved sidecars (the latter rides the boundary
        // codec, decoded by its pack), and a `$`-prefixed sole key would
        // otherwise look like an unrecognized tag.
        return 'data' in (payload ?? {}) ? reviveWire(payload!.data) : undefined;
    };
    // `.with(options)` — the per-call options channel (#353, the rfc-server
    // v2 per-call bullet pulled forward): explicit, so the wire args stay
    // exactly the user's args (no trailing-argument sniffing).
    return Object.assign((...args: unknown[]) => call(args), {
        // The key IS the route, so a build always has one; a hand-built stub
        // passing `''` gets the unstamped sentinel every reader expects (#565).
        __sigxKey: key,
        with:
            (options?: ServerFnCallOptions) =>
            (...args: unknown[]) => {
                if (__DEV__ && options && 'context' in options) {
                    // Stripped from the prod dist, so this costs the
                    // size-limited stub entry nothing.
                    console.warn(
                        `[sigx server] .with({ context }) is ignored on the client — a stub's ` +
                        `context is the HTTP request it makes. It only applies to in-process ` +
                        `(SSR-time) calls; passing it here does not send anything.`
                    );
                }
                return call(args, options);
            }
    });
}

/**
 * Create the streaming client stub for one extracted `serverStream`
 * (rfc-server §6.1): POSTs like a fn stub, consumes the NDJSON body, and
 * yields each `{"chunk"}` value. `{"done"}` ends iteration; `{"error"}`
 * throws the branded wire error. The request starts lazily on first
 * iteration, and consumer `break`/`return()` aborts the fetch (the server
 * generator's `finally` runs).
 *
 * `.with(options)` is the same per-call channel as a fn stub's (#448), minus
 * `fresh` — a stream is always POST and never HTTP-cached.
 */
export function __serverStreamStub(
    key: string,
    name: string,
    endpoint: string,
    version: string
): ((...args: unknown[]) => AsyncIterable<unknown>) & {
    with(options?: ServerStreamCallOptions): (...args: unknown[]) => AsyncIterable<unknown>;
} {
    const call = (args: unknown[], options?: ServerStreamCallOptions): AsyncIterable<unknown> => {
        const controller = new AbortController();
        // A caller's signal is ADDITIVE: the internal controller still aborts
        // on consumer break/return/error, and `AbortSignal.any` is only
        // reached when someone opted into `.with({ signal })` — the
        // zero-config path stays exactly the call it always was.
        const signal = options?.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
        async function* stream(): AsyncGenerator<unknown> {
            try {
                const res = await send(endpoint, key, args, false, version, { ...options, signal });
                if (!res.ok || !res.body) {
                    let wire: WireError | undefined;
                    try {
                        wire = (JSON.parse(await res.text(), reviver) as { error?: WireError })
                            ?.error;
                    } catch {
                        wire = undefined;
                    }
                    const skew = isSkew(res.status, wire);
                    const message = failMessage(name, res.status, skew);
                    throw wireFail(res.status, skew ? { ...wire, message } : wire, message);
                }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let nl;
                    while ((nl = buffer.indexOf('\n')) >= 0) {
                        const text = buffer.slice(0, nl);
                        buffer = buffer.slice(nl + 1);
                        if (!text) continue;
                        const obj = JSON.parse(text, reviver) as {
                            chunk?: unknown;
                            done?: number;
                            error?: WireError;
                        };
                        if ('error' in obj) {
                            throw wireFail(500, obj.error, `server stream "${name}" failed`);
                        }
                        if ('done' in obj) return;
                        yield reviveWire(obj.chunk);
                    }
                }
                // EOF: flush the decoder (a buffered partial code point) and
                // honor a final line missing its trailing newline — proxies
                // may strip it, and NDJSON does not require it.
                buffer += decoder.decode();
                const tail = buffer.trim();
                if (tail) {
                    let obj: { chunk?: unknown; done?: number; error?: WireError } | null = null;
                    try {
                        obj = JSON.parse(tail, reviver);
                    } catch {
                        obj = null; // a partial line — genuine truncation
                    }
                    if (obj) {
                        if ('error' in obj) {
                            throw wireFail(500, obj.error, `server stream "${name}" failed`);
                        }
                        if ('done' in obj) return;
                        yield reviveWire(obj.chunk); // complete chunk — but still no terminator
                    }
                }
                // Body ended without a terminator line — a dropped
                // connection, not a wire error: never mistake truncation
                // for completion.
                throw new Error(
                    `[sigx server] stream "${name}" ended without a done/error terminator ` +
                    `(connection lost?)`
                );
            } finally {
                controller.abort(); // consumer break/return, error, or normal end
            }
        }
        return stream();
    };
    return Object.assign((...args: unknown[]) => call(args), {
        with:
            (options?: ServerStreamCallOptions) =>
            (...args: unknown[]) => {
                if (__DEV__ && options && 'context' in options) {
                    // Stripped from the prod dist, so this costs the
                    // size-limited stub entry nothing.
                    console.warn(
                        `[sigx server] .with({ context }) is ignored on the client — a stub's ` +
                        `context is the HTTP request it makes. It only applies to in-process ` +
                        `(SSR-time) calls; passing it here does not send anything.`
                    );
                }
                return call(args, options);
            }
    });
}

/** Throwing stand-in for a non-`serverFn` value export of a server module. */
export function __serverOnly(name: string, file: string): (...args: unknown[]) => never {
    return function serverOnlyExport(): never {
        throw new Error(
            `[sigx server] "${name}" from ${file} is server-only — it has no client ` +
            `implementation. Wrap it in serverFn() if it should be callable from the browser.`
        );
    };
}
