/**
 * @sigx/server/client — the fetch stubs the `@sigx/vite/server` transform
 * emits imports of (rfc-server §1.1). DEPENDENCY-FREE by contract: resume
 * handler chunks replicate `import { fn } from './x.server'`, which resolves
 * to a generated stub module importing this entry — it must not drag any
 * runtime along (size-limit checks it with no ignore list).
 *
 * Wire format (rfc-server §4): `POST {base}/{symbol}` with
 * `{"args": [...]}`; `200 {"data": ...}` back, or
 * `{status} {"error": {message, status, data?}}`. Errors are re-created with
 * the `__sigxServerFnError` brand so `isServerFnError` matches them.
 */

/** Same three keys as the boundary serializer's DANGEROUS_KEYS — duplicated
 *  here (a 3-entry set) to keep this entry dependency-free. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reviver DROPS prototype-pollution keys from the parsed value (rfc-server §4). */
const reviver = (key: string, value: unknown): unknown =>
    DANGEROUS_KEYS.has(key) ? undefined : value;

interface WireError {
    message?: string;
    status?: number;
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
}

let transport: ServerFnTransport | null = null;

/** Set (or with `null` clear) the transport every stub resolves at call time. */
export function configureServerFn(config: ServerFnTransport | null): void {
    transport = config;
}

/** Create the typed client stub for one extracted server function. */
export function __serverFnStub(
    symbol: string,
    name: string,
    endpoint: string
): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
        // Call-time resolution: configureServerFn endpoint > baked endpoint.
        const config = transport;
        const target = config?.endpoint ?? endpoint;
        const prefix = target.endsWith('/') ? target.slice(0, -1) : target;
        const extra =
            typeof config?.headers === 'function' ? await config.headers() : config?.headers;
        const url = `${prefix}/${encodeURIComponent(symbol)}`;
        const init: RequestInit = {
            method: 'POST',
            // content-type merges LAST — not overridable (the endpoint 415s
            // anything else; rfc-server N.1).
            headers: { ...extra, 'content-type': 'application/json' },
            body: JSON.stringify({ args })
        };
        // Branch instead of aliasing the global fetch — an unbound alias is
        // an illegal invocation in some runtimes, and the zero-config path
        // must stay byte-identical to a plain `fetch(...)` call.
        const res = config?.fetch ? await config.fetch(url, init) : await fetch(url, init);
        const text = await res.text();
        let payload: { data?: unknown; error?: WireError } | undefined;
        try {
            payload = text ? JSON.parse(text, reviver) : undefined;
        } catch {
            payload = undefined; // non-JSON error body (proxy page, …)
        }
        if (!res.ok) {
            const wire = payload?.error;
            // 404 always gets the skew hint — the endpoint's structured 404
            // only ever means "unknown symbol", and the hint is what the
            // user at a stale page can act on.
            const message =
                res.status === 404
                    ? `server function "${name}" not found — the page may be a stale build ` +
                      `(version skew); reload to pick up the current one.`
                    : wire?.message ?? `server function "${name}" failed (HTTP ${res.status})`;
            throw Object.assign(new Error(message), {
                __sigxServerFnError: true,
                status: wire?.status ?? res.status,
                data: wire?.data
            });
        }
        return payload?.data;
    };
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
