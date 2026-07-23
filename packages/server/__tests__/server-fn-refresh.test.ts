/**
 * @vitest-environment node
 *
 * Single-flight boundary refresh — the wire (rfc-server §6.3, #313): the
 * options form's `refreshes` allowlist, the endpoint's `$boundaries`
 * request/response sidecars + `renderBoundaries` option, and the fn stub's
 * collect/apply through the `__SIGX_SERVERFN_BOUNDARIES__` seam.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { serverFn } from '../src/index';
import { handleServerFnRequest, type BoundaryRefreshDescriptor } from '../src/server/index';
import { __serverFnStub, type BoundaryRefreshSeam } from '../src/client/index';

const ORIGIN = 'http://localhost';
const BASE = 1 << 20;

const post = (
    fn: unknown,
    body: unknown,
    renderBoundaries?: (
        requests: ReadonlyArray<BoundaryRefreshDescriptor>,
        base: number,
        rq: unknown
    ) => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>
): Promise<Response> =>
    handleServerFnRequest(
        new Request(`${ORIGIN}/_sigx/fn/m_fn_00000001`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify(body)
        }),
        { resolve: () => fn, ...(renderBoundaries ? { renderBoundaries } : {}) }
    );

const SIDECAR = {
    base: BASE,
    refresh: [
        { id: 3, component: 'Tracker', props: { label: 'hits' } },
        { id: 5, component: 'Other' }
    ]
};

afterEach(() => {
    delete (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: unknown }).__SIGX_SERVERFN_BOUNDARIES__;
});

describe('endpoint — $boundaries envelope (rfc-server §6.3)', () => {
    it('filters descriptors to the declared allowlist and attaches the entries', async () => {
        const seen: { requests?: ReadonlyArray<BoundaryRefreshDescriptor>; base?: number } = {};
        const track = serverFn({
            refreshes: ['Tracker'],
            handler: async () => 'ok'
        });
        const res = await post(track, { args: [{}], $boundaries: SIDECAR }, (requests, base) => {
            seen.requests = requests;
            seen.base = base;
            return [{ for: 3, id: BASE + 1, html: '<b>x</b><!--$c:1048577-->', records: {} }];
        });
        expect(res.status).toBe(200);
        // Only the allowlisted component's descriptor reached the renderer.
        expect(seen.requests).toEqual([{ id: 3, component: 'Tracker', props: { label: 'hits' } }]);
        expect(seen.base).toBe(BASE);
        await expect(res.json()).resolves.toEqual({
            data: 'ok',
            $boundaries: [{ for: 3, id: BASE + 1, html: '<b>x</b><!--$c:1048577-->', records: {} }]
        });
    });

    it('function-form refreshes receives the VALIDATED input and the result', async () => {
        const keys = vi.fn((input: { id: string }, result: string) =>
            result === 'ok' ? [`Tracker:${input.id}`.split(':')[0]] : []
        );
        const track = serverFn({
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (value) => ({ value: { id: String((value as { id?: unknown })?.id) } })
                }
            },
            handler: async () => 'ok',
            refreshes: keys
        });
        const res = await post(track, { args: [{ id: 42 }], $boundaries: SIDECAR }, () => [
            { for: 3, id: BASE + 1, html: '', records: {} }
        ]);
        expect(res.status).toBe(200);
        expect(keys).toHaveBeenCalledWith({ id: '42' }, 'ok');
        expect(((await res.json()) as { $boundaries?: unknown[] }).$boundaries).toHaveLength(1);
    });

    it('is inert without the option, the declaration, or the sidecar', async () => {
        const render = vi.fn(() => [{ for: 3 }]);

        // Declared fn + sidecar, but no renderBoundaries option.
        const declared = serverFn({ refreshes: ['Tracker'], handler: async () => 'ok' });
        await expect(
            (await post(declared, { args: [{}], $boundaries: SIDECAR })).json()
        ).resolves.toEqual({ data: 'ok' });

        // Option + sidecar, but the fn declares nothing.
        const plain = serverFn({ handler: async () => 'ok' });
        await expect(
            (await post(plain, { args: [{}], $boundaries: SIDECAR }, render)).json()
        ).resolves.toEqual({ data: 'ok' });

        // Option + declaration, but the request carried no sidecar.
        await expect(
            (await post(declared, { args: [{}] }, render)).json()
        ).resolves.toEqual({ data: 'ok' });

        expect(render).not.toHaveBeenCalled();
    });

    it('drops malformed sidecars instead of erroring the request', async () => {
        const render = vi.fn(() => [{ for: 3 }]);
        const declared = serverFn({ refreshes: ['Tracker'], handler: async () => 'ok' });

        for (const bad of [
            { base: -1, refresh: [{ id: 3, component: 'Tracker' }] },
            { base: 'high', refresh: [{ id: 3, component: 'Tracker' }] },
            // Ids are counter values: non-integers and beyond-safe-integer
            // magnitudes are rejected outright (precision-loss guard).
            { base: BASE + 0.5, refresh: [{ id: 3, component: 'Tracker' }] },
            { base: 2 ** 53, refresh: [{ id: 3, component: 'Tracker' }] },
            { base: BASE, refresh: 'nope' },
            {
                base: BASE,
                refresh: [
                    { id: 'x', component: 'Tracker' },
                    { id: 3.5, component: 'Tracker' },
                    { id: -3, component: 'Tracker' },
                    { id: 2 ** 53, component: 'Tracker' },
                    { id: 3, component: '' },
                    null
                ]
            },
            'nonsense',
            42
        ]) {
            const res = await post(declared, { args: [{}], $boundaries: bad }, render);
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ data: 'ok' });
        }
        expect(render).not.toHaveBeenCalled();
    });

    it('caps the descriptor count', async () => {
        let received = -1;
        const declared = serverFn({ refreshes: ['Tracker'], handler: async () => 'ok' });
        const flood = {
            base: BASE,
            refresh: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, component: 'Tracker' }))
        };
        await post(declared, { args: [{}], $boundaries: flood }, (requests) => {
            received = requests.length;
            return [];
        });
        expect(received).toBe(32);
    });

    it('a throwing renderBoundaries never fails the mutation — $cache survives', async () => {
        const track = serverFn({
            refreshes: ['Tracker'],
            invalidates: () => [['tracker']],
            handler: async () => 'ok'
        });
        const res = await post(track, { args: [{}], $boundaries: SIDECAR }, () => {
            throw new Error('renderer exploded');
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({
            data: 'ok',
            $cache: { invalidates: [['tracker']] }
        });
    });

    it('omits $boundaries when the renderer declines everything', async () => {
        const track = serverFn({ refreshes: ['Tracker'], handler: async () => 'ok' });
        await expect(
            (await post(track, { args: [{}], $boundaries: SIDECAR }, () => [])).json()
        ).resolves.toEqual({ data: 'ok' });
    });
});

describe('stub — collect/apply through __SIGX_SERVERFN_BOUNDARIES__', () => {
    const okResponse = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });

    it('sends the inventory and applies the entries, in dispatch order', async () => {
        const applied: Array<{ entries: unknown[]; seq: number }> = [];
        const seam: BoundaryRefreshSeam = {
            collect: () => ({ base: BASE, refresh: [{ id: 3, component: 'Tracker' }] }),
            apply: (entries, seq) => applied.push({ entries, seq })
        };
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = seam;

        const bodies: unknown[] = [];
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
            bodies.push(JSON.parse(init!.body as string));
            return okResponse({ data: 1, $boundaries: [{ for: 3, id: BASE + 1, html: '' }] });
        });
        vi.stubGlobal('fetch', fetchMock);

        const stub = __serverFnStub('t_fn_00000001', 't', '/_sigx/fn', undefined, 0, 1);
        await expect(stub('a')).resolves.toBe(1);
        await expect(stub('b')).resolves.toBe(1);
        vi.unstubAllGlobals();

        expect(bodies[0]).toEqual({
            args: ['a'],
            $boundaries: { base: BASE, refresh: [{ id: 3, component: 'Tracker' }] }
        });
        expect(applied).toHaveLength(2);
        expect(applied[0].entries).toEqual([{ for: 3, id: BASE + 1, html: '' }]);
        // seq is dispatch-ordered and strictly increasing across calls.
        expect(applied[1].seq).toBeGreaterThan(applied[0].seq);
    });

    it('sends no sidecar without the flag, the seam, or a non-empty inventory', async () => {
        const bodies: unknown[] = [];
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
            bodies.push(JSON.parse(init!.body as string));
            return okResponse({ data: 'ok' });
        });
        vi.stubGlobal('fetch', fetchMock);

        // Unflagged stub with a live seam: never collected.
        const collect = vi.fn(() => ({ base: BASE, refresh: [{ id: 3, component: 'T' }] }));
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = { collect, apply: () => {} };
        await __serverFnStub('a_fn_00000001', 'a', '/_sigx/fn')('x');
        expect(collect).not.toHaveBeenCalled();

        // Flagged stub with an empty inventory: no sidecar on the wire.
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = { collect: () => ({ base: BASE, refresh: [] }), apply: () => {} };
        await __serverFnStub('b_fn_00000001', 'b', '/_sigx/fn', undefined, 0, 1)('x');

        // Flagged stub, seam absent.
        delete (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: unknown }).__SIGX_SERVERFN_BOUNDARIES__;
        await __serverFnStub('c_fn_00000001', 'c', '/_sigx/fn', undefined, 0, 1)('x');
        vi.unstubAllGlobals();

        expect(bodies).toEqual([{ args: ['x'] }, { args: ['x'] }, { args: ['x'] }]);
    });

    it('swallows collect/apply throws — the RPC result is untouched', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        (globalThis as { __SIGX_SERVERFN_BOUNDARIES__?: BoundaryRefreshSeam })
            .__SIGX_SERVERFN_BOUNDARIES__ = {
                collect: () => {
                    throw new Error('collect boom');
                },
                apply: () => {
                    throw new Error('apply boom');
                }
            };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => okResponse({ data: 'fine', $boundaries: [{ for: 3 }] }))
        );
        const stub = __serverFnStub('t_fn_00000001', 't', '/_sigx/fn', undefined, 0, 1);
        await expect(stub()).resolves.toBe('fine');
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
});

describe('endpoint — fn-ref invalidates patterns (#452)', () => {
    it('resolves bare refs and tuple-embedded refs to stable-key patterns on the wire', async () => {
        const getVotes = Object.assign(serverFn(async () => 3), {
            __sigxKey: 'src/api.server.ts#getVotes'
        });
        const vote = serverFn({
            handler: async () => 'ok',
            invalidates: () => [getVotes, [getVotes, 7], ['custom', 1], 'plain']
        });
        const res = await post(vote, { args: [{}] });
        await expect(res.json()).resolves.toEqual({
            data: 'ok',
            $cache: {
                invalidates: [
                    ['src/api.server.ts#getVotes'],
                    ['src/api.server.ts#getVotes', 7],
                    ['custom', 1],
                    'plain'
                ]
            }
        });
    });

    it('drops a pattern containing an unstamped fn ref, with a dev warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bare = serverFn(async () => 1);
        const vote = serverFn({
            handler: async () => 'ok',
            invalidates: () => [bare, ['k']]
        });
        const res = await post(vote, { args: [{}] });
        await expect(res.json()).resolves.toEqual({
            data: 'ok',
            $cache: { invalidates: [['k']] }
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('__sigxKey'));
        warn.mockRestore();
    });

    it('all patterns dropped ⇒ no $cache on the envelope', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bare = serverFn(async () => 1);
        const vote = serverFn({
            handler: async () => 'ok',
            invalidates: () => [bare]
        });
        const res = await post(vote, { args: [{}] });
        await expect(res.json()).resolves.toEqual({ data: 'ok' });
    });
});
