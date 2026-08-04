/**
 * @vitest-environment node
 *
 * The endpoint-family seam (rfc-server-v4 §3.2, promoted in #625) — what a
 * second endpoint family (`@sigx/actors`) gets so it does not reimplement
 * the pipeline. The pins that matter are the ones that would let the two
 * families drift apart on the auth path:
 *
 *  - `prelude` and `authorize` are the SAME functions the serverFn path
 *    runs — same order, same strict-`true`, same 401-vs-403, same
 *    fail-closed miss;
 *  - the seam needs no app handle and resolves the live app per call (an
 *    `actor()` entry point has a context, never a platform value);
 *  - `resource` reaches the policy, which is the whole point of §7;
 *  - base claiming is ONE registry shared with `serverFns`, scoped per app.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { serverFeature, isServerFnError, type ServerFnInfo } from '../src/index';
import { createServerApp } from '../src/server/index';
import { createTestServerFnContext, stubServerApp } from '../src/testing';

let restore: (() => void) | undefined;
afterEach(() => {
    restore?.();
    restore = undefined;
});

const wire = (name = 'op'): ServerFnInfo => ({ symbol: `T#${name}`, name, transport: 'wire' });
const inProcess = (name = 'op'): ServerFnInfo => ({
    symbol: `T#${name}`,
    name,
    transport: 'in-process'
});

async function statusOf(run: Promise<unknown>): Promise<number | undefined> {
    return run.then(
        () => undefined,
        (error: unknown) => (isServerFnError(error) ? error.status : -1)
    );
}

describe('serverFeature() — the pipeline half', () => {
    it('runs middleware in order, then authenticate, then the identity gate', async () => {
        const order: string[] = [];
        restore = stubServerApp({
            middleware: [
                (_rq, fn) => {
                    order.push(`mw-a:${fn.transport}`);
                },
                () => {
                    order.push('mw-b');
                }
            ],
            authenticate: () => {
                order.push('authenticate');
                return { id: 'u1' };
            }
        });
        await serverFeature().prelude(createTestServerFnContext(), inProcess());
        expect(order).toEqual(['mw-a:in-process', 'mw-b', 'authenticate']);
    });

    it('denies 401 with no app configured, and admits an allowAnonymous operation', async () => {
        expect(await statusOf(serverFeature().prelude(createTestServerFnContext(), wire()))).toBe(
            401
        );
        await expect(
            serverFeature().prelude(createTestServerFnContext(), wire(), { allowAnonymous: true })
        ).resolves.toBeUndefined();
    });

    it('memoizes authentication once per request store', async () => {
        let calls = 0;
        restore = stubServerApp({
            authenticate: () => {
                calls += 1;
                return { id: 'u1' };
            }
        });
        const rq = createTestServerFnContext();
        const feature = serverFeature();
        await feature.prelude(rq, inProcess('a'));
        await feature.prelude(rq, inProcess('b'));
        expect(calls).toBe(1);
    });

    it('resolves the LIVE app per call — one seam value, held at module scope', async () => {
        const feature = serverFeature();
        expect(await statusOf(feature.prelude(createTestServerFnContext(), wire()))).toBe(401);
        restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
        await expect(feature.prelude(createTestServerFnContext(), wire())).resolves.toBeUndefined();
    });
});

describe('serverFeature().authorize — phase B', () => {
    it('passes the resource through to the policy (rfc-server-v4 §7)', async () => {
        const seen: unknown[] = [];
        restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
        const rq = createTestServerFnContext();
        await serverFeature().authorize(rq, {
            fn: wire('addItem'),
            policies: (_p, _rq, op) => {
                seen.push(op.resource);
                return true;
            },
            resource: { kind: 'actor', type: 'Cart', key: 'u_123', method: 'addItem' }
        });
        expect(seen).toEqual([
            { kind: 'actor', type: 'Cart', key: 'u_123', method: 'addItem' }
        ]);
    });

    it('is strict-true: a forgotten return denies 403 for an authenticated caller', async () => {
        restore = stubServerApp({ authenticate: () => ({ id: 'u1' }) });
        const status = await statusOf(
            serverFeature().authorize(createTestServerFnContext(), {
                fn: wire(),
                policies: (() => undefined) as never
            })
        );
        expect(status).toBe(403);
    });

    it('denies 401 rather than 403 when the principal is null', async () => {
        const status = await statusOf(
            serverFeature().authorize(createTestServerFnContext(), {
                fn: wire(),
                allowAnonymous: true,
                policies: () => false
            })
        );
        expect(status).toBe(401);
    });

    it('ANDs a policy array and falls back to the app default when none is declared', async () => {
        restore = stubServerApp({
            authenticate: () => ({ id: 'u1', role: 'user' }),
            authorize: (p) => (p as { role: string }).role === 'admin'
        });
        const rq = createTestServerFnContext();
        // Declared chain wins over the app default (most-specific-wins).
        await expect(
            serverFeature().authorize(rq, { fn: wire(), policies: [() => true, () => true] })
        ).resolves.toBeUndefined();
        await expect(
            serverFeature().authorize(rq, { fn: wire(), policies: [() => true, () => false] })
        ).rejects.toThrow();
        // Undeclared falls through to the app default, which denies 'user'.
        expect(await statusOf(serverFeature().authorize(rq, { fn: wire() }))).toBe(403);
    });

    it('a bare allowAnonymous operation skips the defaults entirely', async () => {
        restore = stubServerApp({ authorize: () => false });
        await expect(
            serverFeature().authorize(createTestServerFnContext(), {
                fn: wire(),
                allowAnonymous: true
            })
        ).resolves.toBeUndefined();
    });
});

describe('serverFeature() — posture, codec, base claiming', () => {
    it('exposes the app posture and principal codec, and empties on a miss', () => {
        const feature = serverFeature();
        expect(feature.posture).toEqual({});
        expect(feature.principalCodec).toBeUndefined();
        const codec = { encode: String, decode: (s: string) => s };
        restore = stubServerApp({ posture: { timeoutMs: 10_000 }, codec });
        expect(feature.posture).toEqual({ timeoutMs: 10_000 });
        expect(feature.principalCodec).toBe(codec);
    });

    it('claims bases against the SAME registry serverFns uses', () => {
        const app = createServerApp({ authenticate: () => ({ id: 'u1' }) });
        restore = () => app.dispose();
        app.serverFns({ resolve: () => null, base: '/_sigx/fn' });
        // A feature mounting under an overlapping prefix is a boot throw.
        expect(() => app.feature().claimBase('/_sigx/fn/extra')).toThrow(/overlaps/);
        // A disjoint namespace is fine — this is what @sigx/actors does.
        expect(() => app.feature().claimBase('/_sigx/actor')).not.toThrow();
    });

    it('scopes claims per app, so a fresh app starts with a clean slate', () => {
        const first = createServerApp({});
        first.serverFns({ resolve: () => null, base: '/_sigx/fn' });
        const second = createServerApp({});
        restore = () => second.dispose();
        expect(() => second.feature().claimBase('/_sigx/fn')).not.toThrow();
    });

    it('claimBase is a no-op with no app stamped — bookkeeping, not permission', () => {
        expect(() => serverFeature().claimBase('/_sigx/actor')).not.toThrow();
        expect(() => serverFeature().claimBase('/_sigx/actor')).not.toThrow();
    });

    it('a mount on a STALE app claims on its own registry, not the live one', () => {
        // Dev HMR: the server-app module re-evaluates, so `second` holds the
        // stamp while `first` is still reachable. A mount on `first` must
        // record against `first` — claiming on the stamped app would both
        // invent overlaps against a stranger's bases and lose its own.
        const first = createServerApp({});
        const second = createServerApp({});
        restore = () => second.dispose();
        first.serverFns({ resolve: () => null, base: '/_sigx/fn' });
        // Landed on `first`: the live app never saw it, so a feature may
        // still claim that prefix now…
        expect(() => second.feature().claimBase('/_sigx/fn')).not.toThrow();
        // …while `first` remembers its own, and re-mounting there collides.
        expect(() => first.serverFns({ resolve: () => null, base: '/_sigx/fn' })).toThrow(
            /overlaps/
        );
    });
});
