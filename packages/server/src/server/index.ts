/**
 * @sigx/server/server — the WinterCG request handler for server functions
 * (rfc-server §4/§5). Request in, Response out — directly usable as an edge
 * fetch handler; `@sigx/server/node` adapts it to connect middleware.
 *
 * Security defaults (§5) are enforced HERE, unconditionally: POST-only,
 * required `application/json` media type, same-origin `Origin` check,
 * `maxBodyBytes` during the body read, reviver-based DROPPING of
 * prototype-pollution keys (they are removed from the parsed value, not a
 * request error), and prod error masking. The `guard` hook runs
 * before EVERY function — the app-wide auth seam that no transport skips.
 */

import { createRequestContext, type ServerFnContext } from '../context';
import { isServerFnError } from '../errors';
import type { ServerFnGuard, WrappedServerFn } from '../types';

export interface ServerFnRequestOptions {
    /**
     * Resolve a transport symbol to its wrapped server function (an object
     * carrying `__sigxFn`). Return null/undefined for unknown symbols —
     * a structured 404 the stub surfaces as a version-skew error.
     */
    resolve(symbol: string): unknown | Promise<unknown>;
    /** Runs unconditionally before EVERY function — THE app-wide auth seam. */
    guard?: ServerFnGuard;
    /**
     * Origin policy. Default `'same-origin'`: the `Origin` header must match
     * the request URL's origin (browsers always send it on POST).
     * `'verify-when-present'` additionally admits requests WITHOUT an
     * `Origin` header — programmatic clients (native apps, CLIs,
     * server-to-server) never send one, and an Origin-less request is not a
     * mainstream browser's cross-site POST (browser CSRF stays blocked by
     * the non-safelisted JSON content-type; this endpoint never emits CORS
     * approval). Never deploy an Origin-stripping proxy in front of a
     * cookie-authenticated app under this policy. An allowlist or `false`
     * makes the endpoint a deliberate public API.
     */
    origin?: 'same-origin' | 'verify-when-present' | string[] | false;
    /** Request body cap in bytes, enforced while reading. Default 1 MiB. */
    maxBodyBytes?: number;
}

/** Same three keys as the boundary serializer's DANGEROUS_KEYS. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const reviver = (key: string, value: unknown): unknown =>
    DANGEROUS_KEYS.has(key) ? undefined : value;

const DEFAULT_MAX_BODY = 1_048_576;

/** JSON error response; headers merge on top of the content-type. */
function errorResponse(
    status: number,
    message: string,
    data?: unknown,
    headers?: Headers,
    extra?: Record<string, string>
): Response {
    const merged = new Headers(headers);
    merged.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(extra ?? {})) merged.set(key, value);
    const error: Record<string, unknown> = { message, status };
    if (data !== undefined) error.data = data;
    return new Response(JSON.stringify({ error }), { status, headers: merged });
}

/**
 * True when REQUEST targets the server-fn endpoint mounted under BASE —
 * the routing predicate platform entries compose with (rfc-deploy §2):
 *
 * ```ts
 * if (matchesServerFn(request)) return handleServerFnRequest(request, opts);
 * return renderDocument(request);
 * ```
 *
 * Deliberately a predicate, not a combinator — composition stays in the
 * user's entry. BASE is the server MOUNT path (rfc-server rev 2's
 * `endpoint`/`base` split): stubs may fetch an absolute `endpoint`, but the
 * deployed handler matches on `base`. The method is not checked — a
 * non-POST to the endpoint should reach the handler's 405, not fall
 * through to the document handler. The bare base with no symbol segment
 * (`/_sigx/fn`) does not match, same as the `/node` adapter's routing.
 */
export function matchesServerFn(request: Request, base = '/_sigx/fn'): boolean {
    const prefix = base.endsWith('/') ? base : base + '/';
    return new URL(request.url).pathname.startsWith(prefix);
}

function checkOrigin(request: Request, policy: ServerFnRequestOptions['origin']): boolean {
    if (policy === false) return true;
    const origin = request.headers.get('origin');
    if (origin === null) return policy === 'verify-when-present';
    if (Array.isArray(policy)) return policy.includes(origin);
    // `Origin: null` (sandboxed iframe, some redirects) is a PRESENT header
    // with the literal value "null" — it fails this comparison, so
    // 'verify-when-present' still rejects it (rfc-server §5.2).
    return origin === new URL(request.url).origin;
}

/** Media type must be application/json; parameters (charset) tolerated. */
function isJsonContentType(request: Request): boolean {
    const raw = request.headers.get('content-type');
    if (!raw) return false;
    return raw.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Read the body, enforcing the byte cap DURING the read. Null ⇒ over cap. */
async function readBody(request: Request, maxBytes: number): Promise<string | null> {
    const declared = request.headers.get('content-length');
    if (declared && Number(declared) > maxBytes) return null;
    if (!request.body) {
        const buffer = await request.arrayBuffer();
        return buffer.byteLength > maxBytes ? null : new TextDecoder().decode(buffer);
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

/**
 * Handle one server-function request. The symbol is the last path segment
 * (`POST {base}/{symbol}` — prefix routing is the mounting adapter's job).
 */
export async function handleServerFnRequest(
    request: Request,
    options: ServerFnRequestOptions
): Promise<Response> {
    if (request.method !== 'POST') {
        return errorResponse(405, 'Method not allowed', undefined, undefined, { Allow: 'POST' });
    }
    if (!isJsonContentType(request)) {
        return errorResponse(415, 'Content-Type must be application/json');
    }
    if (!checkOrigin(request, options.origin)) {
        return errorResponse(403, 'Cross-origin server-function calls are not allowed');
    }

    const pathname = new URL(request.url).pathname;
    const symbol = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    const fn = (await options.resolve(symbol)) as Partial<WrappedServerFn> | null | undefined;
    if (!fn || typeof fn.__sigxFn !== 'function') {
        return errorResponse(404, `Unknown server function "${symbol}"`);
    }
    // The export name is encoded in the symbol — after the '#' for stable
    // symbols (`<stableId>#<name>`, checked FIRST: a stable id may itself
    // contain a hashed-looking `_fn_<hex8>` tail), `<name>_fn_<hash8>` for
    // hashed ones. The impl's own name (`__sigxName`) is often '' for arrows.
    const hashPos = symbol.lastIndexOf('#');
    const info = {
        symbol,
        name:
            hashPos >= 0
                ? symbol.slice(hashPos + 1)
                : /^(.+)_fn_[0-9a-f]{8}$/.exec(symbol)?.[1] ?? fn.__sigxName ?? ''
    };

    const body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY);
    if (body === null) {
        return errorResponse(413, 'Request body too large');
    }
    let args: unknown;
    try {
        args = body ? (JSON.parse(body, reviver) as { args?: unknown }).args : undefined;
    } catch {
        return errorResponse(400, 'Malformed JSON body');
    }
    if (!Array.isArray(args)) {
        return errorResponse(400, 'Body must be {"args": [...]}');
    }

    const ctx = createRequestContext(request);
    try {
        await options.guard?.(ctx as ServerFnContext, info);
        const result = await fn.__sigxFn(ctx, info, args);
        const headers = new Headers(ctx.responseHeaders);
        headers.set('content-type', 'application/json');
        const payload = result === undefined ? '{}' : JSON.stringify({ data: result });
        return new Response(payload, { status: ctx._status ?? 200, headers });
    } catch (error) {
        if (isServerFnError(error)) {
            return errorResponse(error.status, error.message, error.data, ctx.responseHeaders);
        }
        if (__DEV__) {
            const err = error as Error;
            console.error(`[sigx server] "${info.name || symbol}" threw:`, error);
            return errorResponse(500, err?.message ?? 'Internal error', { stack: err?.stack }, ctx.responseHeaders);
        }
        return errorResponse(500, 'Internal error', undefined, ctx.responseHeaders);
    }
}
