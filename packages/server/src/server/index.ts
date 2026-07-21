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
import { runInScope } from '../scope';
import { isServerFnError } from '../errors';
import type { ServerFnGuard, ServerFnInfo, WrappedServerFn } from '../types';
import { encodeWire, reviveWire } from '../wire-codec';

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
    /**
     * Observability seam (#349): called for every MASKED failure — any
     * non-`ServerFnError` throw from guard/handler, timeouts included — in
     * dev AND prod, BEFORE the client response is built. `ServerFnError`s
     * are expected, client-visible errors and do not fire it. AWAITED (an
     * edge runtime may cancel post-response microtasks, losing
     * fire-and-forget telemetry); its own throws are swallowed and never
     * affect the response.
     */
    onError?(error: unknown, info: ServerFnInfo, ctx: ServerFnContext): void | Promise<void>;
    /**
     * Upper bound on guard + handler (+ a stream's first chunk) in
     * milliseconds (#350). On expiry the caller gets a 504,
     * `rq.abortSignal` fires (alongside client disconnect, via
     * `AbortSignal.any`), and `onError` receives the timeout error. A
     * STARTED NDJSON stream is not bounded — the timeout covers
     * time-to-first-byte only. Default: no timeout.
     */
    timeoutMs?: number;
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
    // Captured: TS narrowing does not cross into the work closure below.
    const invoke = fn.__sigxFn;
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
    let parsed: unknown;
    try {
        parsed = body ? (JSON.parse(body, reviver) as { args?: unknown }).args : undefined;
    } catch {
        return errorResponse(400, 'Malformed JSON body');
    }
    if (!Array.isArray(parsed)) {
        return errorResponse(400, 'Body must be {"args": [...]}');
    }
    // Rich types on the way IN (rfc-server §4) — decoded AFTER the
    // prototype-pollution reviver, so dangerous keys are already gone. A
    // malformed tag payload is the caller's bad request, not a 500.
    let args: unknown[];
    try {
        args = parsed.map((arg) => reviveWire(arg));
    } catch {
        return errorResponse(400, 'Malformed encoded value in body');
    }

    const ctx = createRequestContext(request);
    // #350: the timeout controller merges into the context's signal so a
    // cooperative handler cancels cleanly; the race below is what
    // guarantees the 504 when it doesn't. All construction is per-request
    // (workerd forbids module-scope AbortController).
    const timeoutMs = options.timeoutMs;
    const timeoutController = timeoutMs !== undefined ? new AbortController() : null;
    if (timeoutController) {
        ctx.abortSignal = AbortSignal.any([request.signal, timeoutController.signal]);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: Error | undefined;

    // The invocation runs inside a request scope (#309), so a server function
    // calling ANOTHER server function in-process inherits THIS request instead
    // of dropping to the detached context — the live one is right here. Also
    // what registers `__SIGX_SERVERFN_CONTEXT__` on an RPC-only deployment.
    // Unscoped where the runtime has no AsyncLocalStorage; nothing else moves.
    const work = runInScope(ctx as ServerFnContext, async (): Promise<Response> => {
        await options.guard?.(ctx as ServerFnContext, info);
        const result = await invoke(ctx, info, args);
        if (fn.__sigxStream === true) {
            // `await` matters: a pre-first-yield throw must land in THIS
            // catch (buffered JSON error) — a bare `return promise` would
            // bypass it.
            return await streamResponse(
                result as AsyncGenerator<unknown>,
                ctx,
                info.name || symbol,
                options,
                info
            );
        }
        const headers = new Headers(ctx.responseHeaders);
        headers.set('content-type', 'application/json');
        const envelope: Record<string, unknown> = {};
        if (result !== undefined) envelope.data = encodeWire(result);
        // Server-declared cache directives (rfc-server §6.2) — computed
        // where the data changed, from the VALIDATED input the pipeline
        // stashed; a throw here is a fn error (masked per §5).
        if (fn.__sigxInvalidates) {
            const invalidates = await fn.__sigxInvalidates(ctx._input, result);
            if (Array.isArray(invalidates) && invalidates.length > 0) {
                envelope.$cache = { invalidates };
            }
        }
        return new Response(JSON.stringify(envelope), { status: ctx._status ?? 200, headers });
    });

    try {
        if (timeoutMs === undefined) return await work;
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timeoutError = new Error(
                        `[sigx server] "${info.name || symbol}" timed out after ${timeoutMs}ms`
                    );
                    timeoutController!.abort(timeoutError);
                    reject(timeoutError);
                }, timeoutMs);
            })
        ]);
    } catch (error) {
        if (timeoutError !== undefined && error === timeoutError) {
            // The losing work promise must never become an unhandled
            // rejection when it eventually settles.
            void work.catch(() => {});
            await reportMasked(options, timeoutError, info, ctx);
            return errorResponse(504, 'Server function timed out', undefined, ctx.responseHeaders);
        }
        if (!isServerFnError(error)) {
            await reportMasked(options, error, info, ctx);
        }
        const shape = wireErrorShape(error, info.name || symbol);
        return errorResponse(shape.status, shape.message, shape.data, ctx.responseHeaders);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * The #349 observability seam: deliver a masked failure to `onError`,
 * awaited, with the hook's own throws swallowed — telemetry must never
 * affect the response.
 */
async function reportMasked(
    options: ServerFnRequestOptions,
    error: unknown,
    info: ServerFnInfo,
    ctx: ServerFnContext
): Promise<void> {
    if (!options.onError) return;
    try {
        await options.onError(error, info, ctx);
    } catch (hookError) {
        if (__DEV__) console.error('[sigx server] onError hook threw:', hookError);
    }
}

/**
 * The §5 error-masking rules, in one place for both transports: a
 * `ServerFnError` passes through verbatim; anything else is masked to a
 * generic 500 in prod (`__DEV__` includes message + stack).
 */
function wireErrorShape(
    error: unknown,
    label: string
): { message: string; status: number; data?: unknown } {
    if (isServerFnError(error)) {
        // `data` is user payload and may carry rich types like any result.
        // An unencodable one (circular) must not turn a clean 4xx into a 500.
        // An ABSENT `data` stays absent — encoding it would emit `$undef`
        // where the envelope's contract is that the key is simply missing.
        let data: unknown;
        try {
            data = error.data === undefined ? undefined : encodeWire(error.data);
        } catch {
            data = undefined;
            if (__DEV__) {
                console.warn(
                    `[sigx server] "${label}" threw a ServerFnError whose \`data\` ` +
                    `cannot be encoded (circular?) — the error is sent without it.`
                );
            }
        }
        return { message: error.message, status: error.status, data };
    }
    if (__DEV__) {
        const err = error as Error;
        console.error(`[sigx server] "${label}" threw:`, error);
        return { message: err?.message ?? 'Internal error', status: 500, data: { stack: err?.stack } };
    }
    return { message: 'Internal error', status: 500 };
}

/**
 * NDJSON streaming for `serverStream` (rfc-server §6.1): one `{"chunk"}`
 * line per yield, then `{"done":1}` — or `{"error":{…}}` (masked per §5)
 * when the generator throws mid-stream. The FIRST chunk is pulled before
 * the Response exists, so code before the first yield may still set
 * `rq.responseHeaders`/`rq.status()`, and a pre-yield throw propagates to
 * the caller's catch as an ordinary buffered JSON error. Client disconnect
 * cancels the body stream, which returns the generator (its `finally`
 * blocks run).
 */
async function streamResponse(
    gen: AsyncGenerator<unknown>,
    ctx: ReturnType<typeof createRequestContext>,
    label: string,
    options: ServerFnRequestOptions,
    info: ServerFnInfo
): Promise<Response> {
    const first = await gen.next();
    const headers = new Headers(ctx.responseHeaders);
    headers.set('content-type', 'application/x-ndjson');
    const encoder = new TextEncoder();
    const line = (obj: unknown): Uint8Array => encoder.encode(JSON.stringify(obj) + '\n');
    // Fire-and-forget generator cleanup: a no-op on a finished generator, and
    // a throwing `finally` must not become an unhandled rejection.
    const dispose = (): void => void gen.return(undefined).catch(() => {});
    /** Encode one chunk line, rich types included (rfc-server §4). On values
     *  that still cannot be encoded (cycles) the generator is DISPOSED before
     *  the error propagates — an advanced generator must never leak its
     *  `finally`. */
    const chunkLine = (value: unknown): Uint8Array => {
        try {
            return line({ chunk: encodeWire(value) });
        } catch (error) {
            dispose();
            throw error;
        }
    };
    // Pre-encode the first line while a buffered error response is still
    // possible — an unserializable FIRST chunk becomes an ordinary JSON
    // error via the caller's catch.
    const firstLine = first.done ? null : chunkLine(first.value);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            if (firstLine === null) {
                controller.enqueue(line({ done: 1 }));
                controller.close();
                return;
            }
            controller.enqueue(firstLine);
        },
        async pull(controller) {
            try {
                const next = await gen.next();
                if (next.done) {
                    controller.enqueue(line({ done: 1 }));
                    controller.close();
                    return;
                }
                controller.enqueue(chunkLine(next.value));
            } catch (error) {
                // The response has started — the error travels IN-BAND as
                // the terminating NDJSON line (headers are long gone). The
                // masked failure still reaches the observability seam
                // (#349) — a mid-stream prod throw must not be invisible.
                dispose();
                if (!isServerFnError(error)) {
                    await reportMasked(options, error, info, ctx as ServerFnContext);
                }
                let payload: Uint8Array;
                try {
                    payload = line({ error: wireErrorShape(error, label) });
                } catch {
                    // Even the error shape was unserializable (ServerFnError
                    // data with a BigInt, …) — fall back to the masked form.
                    payload = line({ error: { message: 'Internal error', status: 500 } });
                }
                controller.enqueue(payload);
                controller.close();
            }
        },
        cancel() {
            dispose();
        }
    });
    return new Response(body, { status: ctx._status ?? 200, headers });
}

// #351's interim guardrail (`warnNonJsonSafe`) is GONE: it existed only to
// make the JSON-only wire's silent corruption visible in dev, and the wire
// now carries those types for real (rfc-server §4). The one shape still
// unsupported — a circular structure — surfaces as an error, not a warning.
