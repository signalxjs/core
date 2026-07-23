/**
 * @vitest-environment node
 *
 * Zero-JS form actions (rfc-server §6.4/§5.2b, #312): the dual-mode
 * endpoint — form content-types accepted only for form-marked fns,
 * FormData → single-input normalization, the 303 PRG round-trip, HTML
 * error rendering forked on request content-type, and the unrelaxed
 * Origin posture.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleServerFnRequest, type ServerFnRequestOptions } from '../src/server/index';
import { serverFn, serverStream, ServerFnError, type StandardSchemaV1 } from '../src/index';

const ORIGIN = 'http://localhost';
const PAGE = `${ORIGIN}/contact?tab=support`;

/** A minimal Standard Schema: requires { message: non-empty string }. */
const MessageSchema: StandardSchemaV1<{ message: string }> = {
    '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => {
            const message = (value as { message?: unknown })?.message;
            return typeof message === 'string' && message.length > 0
                ? { value: { message } }
                : { issues: [{ message: 'message must be a non-empty string', path: ['message'] }] };
        }
    }
};

/**
 * #412's escape hatch: form targets REQUIRE `input` (definition-time error);
 * a deliberate raw-field-map target declares a pass-through schema.
 */
const PassThrough: StandardSchemaV1<Record<string, unknown>> = {
    '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value: value as Record<string, unknown> })
    }
};

const submit = serverFn({
    form: true,
    input: MessageSchema,
    handler: async (_rq, input) => ({ saved: input.message })
});
const jsonOnly = serverFn(async (_rq, a: number) => a);
const withRedirect = serverFn({
    form: true,
    input: PassThrough,
    handler: async (rq) => {
        rq.responseHeaders.set('location', '/thanks');
        return null;
    }
});
const ownStatus = serverFn({
    form: true,
    input: PassThrough,
    handler: async (rq) => {
        rq.status(200);
        return 'owned';
    }
});
const mutating = serverFn({
    form: true,
    input: PassThrough,
    invalidates: () => [['cart']],
    handler: async () => 'done'
});
const stream = serverStream(async function* (): AsyncGenerator<string> {
    yield 'x';
});

const FNS: Record<string, unknown> = {
    'app/contact.server.ts#submit': submit,
    json_fn_00000002: jsonOnly,
    redir_fn_00000003: withRedirect,
    own_fn_00000004: ownStatus,
    mut_fn_00000005: mutating,
    stream_fn_00000006: stream
};

function formPost(
    symbol: string,
    body: URLSearchParams | FormData | string,
    init: { headers?: Record<string, string>; noOrigin?: boolean; noReferer?: boolean } = {},
    options: Partial<ServerFnRequestOptions> = {}
): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (!init.noOrigin) headers.origin = ORIGIN;
    if (!init.noReferer) headers.referer = PAGE;
    if (typeof body === 'string' && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const request = new Request(`${ORIGIN}/_sigx/fn/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers,
        body
    });
    return handleServerFnRequest(request, {
        resolve: (sym) => FNS[sym] ?? null,
        ...options
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('form-mode success — 303 PRG (§6.4)', () => {
    it('urlencoded POST to a form-marked fn redirects back to the same-origin Referer', async () => {
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/contact?tab=support');
        expect(res.body).toBeNull();
    });

    it('a cross-origin Referer is not trusted — falls back to /', async () => {
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }), {
            headers: { referer: 'https://evil.example/phish' },
            noReferer: true
        });
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/');
    });

    it('no Referer falls back to /', async () => {
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }), {
            noReferer: true
        });
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/');
    });

    it('a handler-set Location wins over the Referer default', async () => {
        const res = await formPost('redir_fn_00000003', new URLSearchParams({ x: '1' }));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/thanks');
    });

    it('a handler-set non-3xx status is honored verbatim, no default Location', async () => {
        const res = await formPost('own_fn_00000004', new URLSearchParams({ x: '1' }));
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
    });

    it('multipart round-trips: repeated names → array, File passes through', async () => {
        const fd = new FormData();
        fd.append('tags', 'a');
        fd.append('tags', 'b');
        fd.append('doc', new File(['hello'], 'note.txt', { type: 'text/plain' }));
        fd.append('single', 'one');
        let seen: Record<string, unknown> | undefined;
        const catcher = serverFn({
            form: true,
            input: PassThrough,
            handler: async (_rq, input: Record<string, unknown>) => {
                seen = input;
                return null;
            }
        });
        const res = await formPost('c', fd, {}, { resolve: () => catcher });
        expect(res.status).toBe(303);
        expect(seen!.tags).toEqual(['a', 'b']);
        expect(seen!.single).toBe('one');
        expect(seen!.doc).toBeInstanceOf(File);
        expect(await (seen!.doc as File).text()).toBe('hello');
    });

    it('dangerous field names are dropped from the normalized input', async () => {
        let seen: Record<string, unknown> | undefined;
        const catcher = serverFn({
            form: true,
            input: PassThrough,
            handler: async (_rq, input: Record<string, unknown>) => {
                seen = input;
                return null;
            }
        });
        await formPost('c', new URLSearchParams([['__proto__', 'x'], ['ok', '1']]), {}, { resolve: () => catcher });
        expect(seen).toEqual({ ok: '1' });
        expect(Object.getPrototypeOf(seen)).toBe(Object.prototype);
    });

    it('invalidates never runs on the form branch, but still runs for JSON callers', async () => {
        const keys = vi.fn(() => [['cart']]);
        const fn = serverFn({
            form: true,
            input: PassThrough,
            invalidates: keys,
            handler: async () => 'done'
        });
        const formRes = await formPost('m', new URLSearchParams({ x: '1' }), {}, { resolve: () => fn });
        expect(formRes.status).toBe(303);
        expect(keys).not.toHaveBeenCalled();

        const jsonRes = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/m`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[{}]}'
            }),
            { resolve: () => fn }
        );
        expect(keys).toHaveBeenCalledOnce();
        await expect(jsonRes.json()).resolves.toEqual({ data: 'done', $cache: { invalidates: [['cart']] } });
    });
});

describe('gating (§6.4/§5.2b)', () => {
    it('a form POST to an UNMARKED fn is 415 with an HTML body', async () => {
        const res = await formPost('json_fn_00000002', new URLSearchParams({ a: '1' }));
        expect(res.status).toBe(415);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('a form POST to a serverStream is 415', async () => {
        const res = await formPost('stream_fn_00000006', new URLSearchParams({ a: '1' }));
        expect(res.status).toBe(415);
    });

    it('a JSON POST to a form-marked fn keeps the envelope byte-for-byte', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/app%2Fcontact.server.ts%23submit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({ args: [{ message: 'hi' }] })
            }),
            { resolve: (sym) => FNS[sym] ?? null }
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual({ data: { saved: 'hi' } });
    });

    it('an absent Origin on a form POST is 403 under the default policy — no GET-style relaxation', async () => {
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }), {
            noOrigin: true
        });
        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('verify-when-present admits an Origin-less form POST (the documented §5.2b risk)', async () => {
        const res = await formPost(
            'app/contact.server.ts#submit',
            new URLSearchParams({ message: 'hi' }),
            { noOrigin: true },
            { origin: 'verify-when-present' }
        );
        expect(res.status).toBe(303);
    });

    it('a mismatching Origin is 403', async () => {
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }), {
            headers: { origin: 'https://evil.example' },
            noOrigin: true
        });
        expect(res.status).toBe(403);
    });

    it('an unknown symbol on the form path 404s as HTML', async () => {
        const res = await formPost('gone_fn_ffffffff', new URLSearchParams({ a: '1' }));
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('text/html');
    });
});

describe('errors fork on request content-type, never on the fn (§6.4)', () => {
    it('validation failure: form POST → 400 HTML with the issues listed (dev), escaped', async () => {
        const res = await formPost(
            'app/contact.server.ts#submit',
            new URLSearchParams({ message: '', '<script>': 'x' })
        );
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('text/html');
        const html = await res.text();
        expect(html).toContain('message must be a non-empty string');
        expect(html).not.toContain('<script>');
    });

    it('validation failure: JSON POST to the same fn → JSON error with issues', async () => {
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/s`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: '{"args":[{"message":""}]}'
            }),
            { resolve: () => submit }
        );
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = (await res.json()) as { error: { message: string; data: { issues: unknown[] } } };
        expect(body.error.message).toBe('Invalid input');
        expect(body.error.data.issues).toHaveLength(1);
    });

    it('a thrown ServerFnError renders as HTML on the form path', async () => {
        const thrower = serverFn({
            form: true,
            input: PassThrough,
            handler: async () => {
                throw new ServerFnError(409, 'already submitted');
            }
        });
        const res = await formPost('t', new URLSearchParams({ a: '1' }), {}, { resolve: () => thrower });
        expect(res.status).toBe(409);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('already submitted');
    });

    it('a declared content-length over maxBodyBytes is 413 HTML', async () => {
        const res = await formPost(
            'app/contact.server.ts#submit',
            'message=hi',
            { headers: { 'content-length': '99999', 'content-type': 'application/x-www-form-urlencoded' } },
            { maxBodyBytes: 1024 }
        );
        expect(res.status).toBe(413);
        expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('a malformed Content-Length is a 400, not a bypassed cap', async () => {
        for (const bad of ['abc', '-5']) {
            const res = await formPost(
                'app/contact.server.ts#submit',
                'message=hi',
                { headers: { 'content-length': bad, 'content-type': 'application/x-www-form-urlencoded' } },
                { maxBodyBytes: 1024 }
            );
            expect(res.status).toBe(400);
            expect(res.headers.get('content-type')).toContain('text/html');
        }
    });

    it('a timeout on the form path is a 504 HTML page', async () => {
        const hung = serverFn({
            form: true,
            input: PassThrough,
            handler: () => new Promise<never>(() => {})
        });
        const onError = vi.fn();
        const res = await formPost('h', new URLSearchParams({ a: '1' }), {}, {
            resolve: () => hung,
            timeoutMs: 20,
            onError
        });
        expect(res.status).toBe(504);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('the guard runs on the form path and its rejection renders as HTML', async () => {
        const guard = vi.fn(() => {
            throw new ServerFnError(401, 'sign in first');
        });
        const res = await formPost('app/contact.server.ts#submit', new URLSearchParams({ message: 'hi' }), {}, { guard });
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(guard).toHaveBeenCalledOnce();
    });
});

describe('definition-time checks (§6.4, #412)', () => {
    it('form + cache warns (a form target is a mutation)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serverFn({
            form: true,
            input: PassThrough,
            cache: { maxAge: 60 },
            handler: async function conflicted() {
                return 1;
            }
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('a form target is a mutation'));
    });

    it('form without input throws at definition (validator is load-bearing)', () => {
        expect(() =>
            serverFn({
                form: true,
                handler: async function bare() {
                    return 1;
                }
            })
        ).toThrow(/`input`/);
    });

    it('form without input throws in production too — not __DEV__-gated', () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            expect(() =>
                serverFn({
                    form: true,
                    handler: async function bare() {
                        return 1;
                    }
                })
            ).toThrow(/`input`/);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('form with input does not warn or throw', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serverFn({
            form: true,
            input: MessageSchema,
            handler: async (_rq, input) => input
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('a pass-through schema is the deliberate raw-field-map opt-out', async () => {
        let seen: Record<string, unknown> | undefined;
        const raw = serverFn({
            form: true,
            input: PassThrough,
            handler: async (_rq, input) => {
                seen = input;
                return null;
            }
        });
        const res = await formPost('raw', new URLSearchParams({ any: 'thing' }), {}, { resolve: () => raw });
        expect(res.status).toBe(303);
        expect(seen).toEqual({ any: 'thing' });
    });
});
