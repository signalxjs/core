/**
 * @vitest-environment node
 *
 * createServerApp() — the server platform value (rfc-server-v4 §3): the
 * seam stamp (last-wins, HMR-safe), `dispose()`'s identity rule, posture
 * inheritance (app → mount → built-in default), the `serverFns` mount,
 * `claimBase`'s boot throw, and `authorizeBoundary` (the §6.3 gap).
 * Pipeline ORDER pins live in app-pipeline.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createServerApp,
    handleServerFnRequest,
    type ServerApp
} from '../src/server/index';
import { serverFn, ServerFnError, principal } from '../src/index';
import { stampServerAppConfig } from '../src/app-config';

const ORIGIN = 'http://localhost';

const apps: ServerApp<unknown>[] = [];
const app = <P>(options: Parameters<typeof createServerApp<P>>[0]): ServerApp<P> => {
    const created = createServerApp<P>(options);
    apps.push(created as ServerApp<unknown>);
    return created;
};

afterEach(() => {
    for (const a of apps.splice(0)) a.dispose();
    // Belt and braces: a test that replaced the stamp outside `app()` must
    // not leak into the next one.
    stampServerAppConfig(undefined);
    vi.restoreAllMocks();
});

const post = (path: string, body: unknown): Request =>
    new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify(body)
    });

describe('createServerApp — the seam stamp', () => {
    it('stamps at creation; the pipeline applies to a plain in-process call', async () => {
        app({ authenticate: () => ({ id: 'u1' }) });
        const whoami = serverFn({
            handler: async (rq) => (await principal<{ id: string }>(rq))?.id
        });
        await expect(whoami()).resolves.toBe('u1');
    });

    it('is last-wins with a __DEV__ note — HMR re-evaluation must never throw', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        app({ authenticate: () => ({ id: 'first' }) });
        expect(warn).not.toHaveBeenCalled();
        app({ authenticate: () => ({ id: 'second' }) });
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('replaced an already-stamped server app')
        );
    });

    it('dispose() releases the seam — but never tears down a REPLACEMENT app', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = app({ authenticate: () => ({ id: 'first' }) });
        const second = app({ authenticate: () => ({ id: 'second' }) });
        // Disposing the superseded app is a no-op: the live stamp is not its.
        first.dispose();
        const whoami = serverFn({
            handler: async (rq) => (await principal<{ id: string }>(rq))?.id
        });
        await expect(whoami()).resolves.toBe('second');
        // Disposing the live one clears the seam → fail-closed again.
        second.dispose();
        const error = await whoami().catch((e: unknown) => e);
        expect((error as ServerFnError).status).toBe(401);
    });

    it('copies the middleware array once — a chain the app can push to is not a policy', async () => {
        const ran: string[] = [];
        const middleware = [
            (): void => {
                ran.push('initial');
            }
        ];
        app({ middleware, authenticate: () => ({ id: 'u1' }) });
        middleware.push((): void => {
            ran.push('smuggled');
        });
        const fn = serverFn({ handler: async () => 'ok' });
        await fn();
        expect(ran).toEqual(['initial']);
    });
});

describe('posture inheritance (rfc-server-v4 §3.1)', () => {
    it('a mount inherits the app posture; an explicit mount value wins', async () => {
        const created = app({
            authenticate: () => ({ id: 'u1' }),
            maxBodyBytes: 10 // tiny app-wide cap
        });
        const echo = serverFn({ handler: async (_rq, v: unknown) => v });
        const resolve = (): unknown => echo;

        // Inherited: an 11-byte body trips the app's cap through the mount.
        const capped = created.serverFns({ resolve });
        const big = await capped(post('/_sigx/fn/echo_fn_1', { args: ['0123456789abcdef'] }));
        expect(big.status).toBe(413);

        // Overridden per mount (needs its own base — namespaces don't share).
        const roomy = created.serverFns({ resolve, base: '/rpc', maxBodyBytes: 1024 });
        const ok = await roomy(
            new Request(`${ORIGIN}/rpc/echo_fn_1`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({ args: ['0123456789abcdef'] })
            })
        );
        expect(ok.status).toBe(200);
    });

    it('a bare handleServerFnRequest inherits the posture too — the primitive stays correct', async () => {
        app({ authenticate: () => ({ id: 'u1' }), timeoutMs: 20 });
        const slow = serverFn({
            handler: () => new Promise((r) => setTimeout(() => r('late'), 200))
        });
        const res = await handleServerFnRequest(post('/_sigx/fn/slow_fn_1', { args: [] }), {
            resolve: () => slow
        });
        expect(res.status).toBe(504);
    });

    it('an explicit `origin: false` on the call is not clobbered by the app posture', async () => {
        app({ authenticate: () => ({ id: 'u1' }), origin: 'same-origin' });
        const fn = serverFn({ handler: async () => 'ok' });
        // Cross-origin request; the CALL says origin: false (deliberate
        // public API) — explicit wins over the app's same-origin.
        const res = await handleServerFnRequest(
            new Request(`${ORIGIN}/_sigx/fn/x_fn_1`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
                body: '{"args":[]}'
            }),
            { resolve: () => fn, origin: false }
        );
        expect(res.status).toBe(200);
    });
});

describe('serverFns mounts and claimBase', () => {
    it('two mounts on distinct bases coexist; an overlapping base throws at MOUNT time', () => {
        const created = app({ authenticate: () => ({ id: 'u1' }) });
        const resolve = (): null => null;
        created.serverFns({ resolve });                       // /_sigx/fn
        created.serverFns({ resolve, base: '/rpc' });         // fine
        expect(() => created.serverFns({ resolve, base: '/rpc' })).toThrow(/overlaps/);
        // Prefix overlap in either direction — "everything after the base
        // IS the symbol" (#543) would slice the other family's symbols.
        expect(() => created.serverFns({ resolve, base: '/rpc/inner' })).toThrow(/overlaps/);
    });

    it('a mount handler serves requests bound to its own base and options', async () => {
        const created = app({ authenticate: () => ({ id: 'u1' }) });
        const add = serverFn(async (_rq, a: number, b: number) => a + b);
        const fns = created.serverFns({
            resolve: (s) => (s === 'add_fn_1' ? add : null),
            base: '/api/fns'
        });
        const res = await fns(post('/api/fns/add_fn_1', { args: [2, 3] }));
        await expect(res.json()).resolves.toEqual({ data: 5 });
    });
});

describe('authorizeBoundary — the §6.3 per-boundary veto', () => {
    /** A mutation with invalidates + a sidecar asking to refresh 2 boundaries. */
    const setup = (
        authorizeBoundary?: (rq: unknown, b: { component: string }) => boolean | Promise<boolean>
    ) => {
        const getVotes = serverFn({ allowAnonymous: true, handler: async () => 1 });
        (getVotes as { __sigxKey: string }).__sigxKey = 'votes/getVotes';
        const vote = serverFn({
            allowAnonymous: true,
            handler: async () => 'voted',
            invalidates: () => [getVotes]
        });
        const rendered: string[] = [];
        const options = {
            resolve: () => vote,
            renderBoundaries: (requests: ReadonlyArray<{ component: string; id: number }>) => {
                for (const r of requests) rendered.push(r.component);
                return requests.map((r) => ({ for: r.id, html: '<p/>' }));
            },
            ...(authorizeBoundary
                ? { authorizeBoundary: authorizeBoundary as never }
                : {})
        };
        const body = {
            args: [],
            $boundaries: {
                base: 100,
                refresh: [
                    { id: 1, component: 'Poll', deps: ['["votes/getVotes"]'] },
                    { id: 2, component: 'Admin', deps: ['["votes/getVotes"]'] }
                ]
            }
        };
        return { options, body, rendered };
    };

    it('without the hook, both admitted boundaries render (baseline)', async () => {
        const { options, body, rendered } = setup();
        const res = await handleServerFnRequest(post('/_sigx/fn/vote_fn_1', body), options);
        const envelope = (await res.json()) as { $boundaries?: unknown[] };
        expect(rendered).toEqual(['Poll', 'Admin']);
        expect(envelope.$boundaries).toHaveLength(2);
    });

    it('a deny drops THAT descriptor; the rest render and the mutation is untouched', async () => {
        const { options, body, rendered } = setup((_rq, b) => b.component !== 'Admin');
        const res = await handleServerFnRequest(post('/_sigx/fn/vote_fn_1', body), options);
        const envelope = (await res.json()) as { data: string; $boundaries?: unknown[] };
        expect(envelope.data).toBe('voted');
        expect(rendered).toEqual(['Poll']);
        expect(envelope.$boundaries).toHaveLength(1);
    });

    it('strict-true: a non-boolean-true result denies', async () => {
        const { options, body, rendered } = setup(() => 1 as unknown as boolean);
        const res = await handleServerFnRequest(post('/_sigx/fn/vote_fn_1', body), options);
        const envelope = (await res.json()) as { data: string; $boundaries?: unknown[] };
        expect(envelope.data).toBe('voted');
        expect(rendered).toEqual([]);
        expect(envelope.$boundaries).toBeUndefined();
    });

    it('a THROW drops the whole refresh, never the mutation', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { options, body, rendered } = setup(() => {
            throw new Error('policy exploded');
        });
        const res = await handleServerFnRequest(post('/_sigx/fn/vote_fn_1', body), options);
        const envelope = (await res.json()) as { data: string; $boundaries?: unknown[] };
        expect(res.status).toBe(200);
        expect(envelope.data).toBe('voted');
        expect(rendered).toEqual([]);
        expect(envelope.$boundaries).toBeUndefined();
    });
});
