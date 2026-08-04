/**
 * @vitest-environment node
 *
 * Two endpoint requests INTERLEAVED in one process (#568).
 *
 * Every per-request facility here — the validated-input stash the
 * `invalidates` seam reads (`ctx._input`), `rq.locals`, `perRequest` values,
 * `rq.responseHeaders` — is asserted per call elsewhere, and per call is the
 * case that cannot fail. The one that can is two requests in flight at once,
 * which is the normal state of a real server: a value parked on a module-level
 * variable instead of the context passes every existing test and leaks one
 * user's data into another's response.
 *
 * The handlers below park on explicit gates so the interleaving is exact
 * rather than hopeful: A enters, B runs to completion, then A resumes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { perRequest, serverFn, type ServerFnContext } from '../src/index';
import { handleServerFnRequest, type ServerFnRequestOptions } from '../src/server/index';
import { stubServerApp } from '../src/testing';

// The pipeline is fail-closed (rfc-server-v4 §2.1): stub an authenticated
// app so the interleaving under test stays the subject.
let restoreApp: () => void;
beforeEach(() => {
    restoreApp = stubServerApp({ authenticate: () => ({ id: 'tester' }) });
});
afterEach(() => {
    restoreApp();
});

const ORIGIN = 'http://localhost';

const post = (symbol: string, args: unknown[] = [], headers: Record<string, string> = {}): Request =>
    new Request(`${ORIGIN}/_sigx/fn/${symbol}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify({ args })
    });

/** A deferred, for parking one request inside its handler. */
function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    return { wait, open };
}

/** Pass-through Standard Schema — enough to make the options form validate. */
const PassThrough = {
    '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value })
    }
};

describe('interleaved requests keep per-request state apart', () => {
    it('the invalidates seam sees ITS OWN validated input, not the other request\'s', async () => {
        const first = gate();
        const seen: string[] = [];

        const mutate = serverFn({
            input: PassThrough,
            invalidates: (input) => {
                // The endpoint reads the input the pipeline stashed on the
                // context. A module-level stash would hand B's input to A.
                seen.push((input as { id: string }).id);
                return [['cart', (input as { id: string }).id]];
            },
            handler: async (_rq, input: { id: string }) => {
                if ((input as { id: string }).id === 'A') await first.wait;
                return input;
            }
        });

        const options: Partial<ServerFnRequestOptions> = { resolve: () => mutate };
        const a = handleServerFnRequest(post('m', [{ id: 'A' }]), options as ServerFnRequestOptions);
        // B runs start to finish while A is parked inside its handler.
        const bRes = await handleServerFnRequest(post('m', [{ id: 'B' }]), options as ServerFnRequestOptions);
        first.open();
        const aRes = await a;

        expect(await bRes.json()).toEqual({
            data: { id: 'B' },
            $cache: { invalidates: [['cart', 'B']] }
        });
        expect(await aRes.json()).toEqual({
            data: { id: 'A' },
            $cache: { invalidates: [['cart', 'A']] }
        });
        // B's seam ran first — the ORDER is what proves they interleaved.
        expect(seen).toEqual(['B', 'A']);
    });

    it('rq.locals written by middleware belong to one request only', async () => {
        const first = gate();
        const observed: Array<string | undefined> = [];

        const whoami = serverFn(async (rq: ServerFnContext) => {
            const user = rq.locals.user as string | undefined;
            if (user === 'alice') await first.wait;
            observed.push(rq.locals.user as string | undefined);
            return rq.locals.user;
        });

        restoreApp();
        restoreApp = stubServerApp({
            middleware: [
                (ctx) => {
                    ctx.locals.user = ctx.request.headers.get('x-user') ?? undefined;
                }
            ],
            authenticate: () => ({ id: 'tester' })
        });
        const options = { resolve: () => whoami } as unknown as ServerFnRequestOptions;

        const a = handleServerFnRequest(post('w', [], { 'x-user': 'alice' }), options);
        const bRes = await handleServerFnRequest(post('w', [], { 'x-user': 'bob' }), options);
        first.open();
        const aRes = await a;

        expect(await bRes.json()).toEqual({ data: 'bob' });
        expect(await aRes.json()).toEqual({ data: 'alice' });
        expect(observed).toEqual(['bob', 'alice']);
    });

    it('a perRequest value is computed once PER REQUEST, not once per process', async () => {
        const first = gate();
        let computed = 0;
        const session = perRequest(async (rq: ServerFnContext) => {
            computed += 1;
            return rq.request.headers.get('x-user');
        });

        const readTwice = serverFn(async (rq: ServerFnContext) => {
            const a = await session(rq);
            if (a === 'alice') await first.wait;
            const b = await session(rq);
            // Same request ⇒ the memoized value, whatever ran in between.
            expect(b).toBe(a);
            return a;
        });

        const options = { resolve: () => readTwice } as unknown as ServerFnRequestOptions;
        const a = handleServerFnRequest(post('s', [], { 'x-user': 'alice' }), options);
        const bRes = await handleServerFnRequest(post('s', [], { 'x-user': 'bob' }), options);
        first.open();
        const aRes = await a;

        expect(await bRes.json()).toEqual({ data: 'bob' });
        expect(await aRes.json()).toEqual({ data: 'alice' });
        // Twice — once per request, not once per process and not once per read.
        expect(computed).toBe(2);
    });

    it('response headers set by one request do not appear on the other', async () => {
        const first = gate();
        const setsCookie = serverFn(async (rq: ServerFnContext, who: string) => {
            rq.responseHeaders.set('x-who', who);
            if (who === 'alice') await first.wait;
            return who;
        });

        const options = { resolve: () => setsCookie } as unknown as ServerFnRequestOptions;
        const a = handleServerFnRequest(post('h', ['alice']), options);
        const bRes = await handleServerFnRequest(post('h', ['bob']), options);
        first.open();
        const aRes = await a;

        expect(bRes.headers.get('x-who')).toBe('bob');
        expect(aRes.headers.get('x-who')).toBe('alice');
    });
});
