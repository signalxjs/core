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

/** Reviver-based rejection of prototype-pollution keys (rfc-server §4). */
const reviver = (key: string, value: unknown): unknown =>
    DANGEROUS_KEYS.has(key) ? undefined : value;

interface WireError {
    message?: string;
    status?: number;
    data?: unknown;
}

/** Create the typed client stub for one extracted server function. */
export function __serverFnStub(
    symbol: string,
    name: string,
    base: string
): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
        const res = await fetch(`${base}/${symbol}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ args })
        });
        const text = await res.text();
        let payload: { data?: unknown; error?: WireError } | undefined;
        try {
            payload = text ? JSON.parse(text, reviver) : undefined;
        } catch {
            payload = undefined; // non-JSON error body (proxy page, …)
        }
        if (!res.ok) {
            const wire = payload?.error;
            const message =
                wire?.message ??
                (res.status === 404
                    ? `server function "${name}" not found — the page may be a stale build ` +
                      `(version skew); reload to pick up the current one.`
                    : `server function "${name}" failed (HTTP ${res.status})`);
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
