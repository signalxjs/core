/**
 * Seam hygiene (#634) — the two properties the descriptor work buys, both of
 * which rot silently if nothing asserts them.
 *
 * 1. `__SIGX_SERVER_APP__` is a FAIL-CLOSED control seam (`docs/seams.md`):
 *    it carries `authenticate`/`authorize`, so a mutation nothing notices is
 *    a fail-OPEN. Wholesale replacement already dev-warns; the in-place member
 *    swap did not, and now throws.
 * 2. The pack-internal seams are NON-ENUMERABLE, so they stay out of
 *    `Object.keys(globalThis)` and devtools completion. The wire seams
 *    deliberately stay enumerable — see the sibling assertions in
 *    runtime-core/cache/resume.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveServerAppConfig, stampServerAppConfig, claimAppBase } from '../src/app-config';
import { registerWireTypeHandlers } from '../src/plugin';
import { runWithServerFnContext } from '../src/node';

afterEach(() => {
    stampServerAppConfig(undefined);
});

describe('__SIGX_SERVER_APP__ cannot be mutated open', () => {
    it('rejects an in-place authorize swap on a stamped config', () => {
        stampServerAppConfig({ authorize: () => false });
        const config = resolveServerAppConfig()!;

        // The fail-open this closes: `globalThis.__SIGX_SERVER_APP__.authorize
        // = () => true`. Frozen, so strict mode (every ES module) throws.
        expect(() => {
            (config as { authorize?: unknown }).authorize = () => true;
        }).toThrow(TypeError);

        expect(resolveServerAppConfig()!.authorize).toBe(config.authorize);
    });

    it('rejects an in-place authenticate swap, and deleting a member', () => {
        stampServerAppConfig({ authenticate: () => ({ id: 'u1' }) });
        const config = resolveServerAppConfig()!;
        expect(() => {
            (config as { authenticate?: unknown }).authenticate = () => ({ id: 'root' });
        }).toThrow(TypeError);
        expect(() => {
            delete (config as { authenticate?: unknown }).authenticate;
        }).toThrow(TypeError);
    });

    it('still allows wholesale replacement — HMR and stubServerApp need it', () => {
        stampServerAppConfig({ authorize: () => false });
        const replacement = { authorize: (): boolean => true };
        stampServerAppConfig(replacement);
        expect(resolveServerAppConfig()).toBe(replacement);
    });

    it('claimAppBase still works against a frozen config', () => {
        // The subtle part: `claimAppBase` does `config.claimedBases ??= []`,
        // which would throw on a frozen object. The stamp pre-seeds the array
        // so the `??=` short-circuits, and freeze is shallow so `push` works.
        stampServerAppConfig({});
        expect(() => claimAppBase('/_sigx/a')).not.toThrow();
        expect(() => claimAppBase('/_sigx/b')).not.toThrow();
        expect(resolveServerAppConfig()!.claimedBases).toHaveLength(2);
        // And the overlap guard it exists for still fires.
        expect(() => claimAppBase('/_sigx/a')).toThrow(/overlaps an existing mount/);
    });

    it('re-stamping an already-frozen config is a no-op, not a throw', () => {
        // stubServerApp's teardown hands back the config this function froze
        // on the way in; `??=` on a frozen object with the key absent would
        // throw, which is why the seeding is guarded on `isFrozen`.
        const first = { authorize: (): boolean => false };
        stampServerAppConfig(first);
        stampServerAppConfig({ authorize: () => true });
        expect(() => stampServerAppConfig(first)).not.toThrow();
        expect(resolveServerAppConfig()).toBe(first);
    });
});

describe('pack-internal seams stay off the enumerable global surface', () => {
    function descriptor(name: string): PropertyDescriptor | undefined {
        return Object.getOwnPropertyDescriptor(globalThis, name);
    }

    it('__SIGX_SERVER_APP__ is non-enumerable once stamped', () => {
        stampServerAppConfig({});
        expect(descriptor('__SIGX_SERVER_APP__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_SERVER_APP__');
    });

    it('__SIGX_SERVERFN_CODEC__ is non-enumerable once registered', () => {
        registerWireTypeHandlers([]);
        expect(descriptor('__SIGX_SERVERFN_CODEC__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_SERVERFN_CODEC__');
    });

    it('__SIGX_SERVERFN_SCOPE__ is non-enumerable — stamped at import', () => {
        expect(descriptor('__SIGX_SERVERFN_SCOPE__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_SERVERFN_SCOPE__');
    });

    it('__SIGX_SERVERFN_CONTEXT__ is non-enumerable, and stays so across re-stamps', async () => {
        // Re-asserted on EVERY scope entry, so the second entry must not
        // resurrect it as an enumerable plain assignment.
        await runWithServerFnContext(new Request('https://x.test/'), () => undefined);
        expect(descriptor('__SIGX_SERVERFN_CONTEXT__')?.enumerable).toBe(false);
        await runWithServerFnContext(new Request('https://x.test/'), () => undefined);
        expect(descriptor('__SIGX_SERVERFN_CONTEXT__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_SERVERFN_CONTEXT__');
    });

    it('HIDES a seam an earlier plain assignment left enumerable', () => {
        // Dev HMR's older module copy, or an app stamping the codec by hand,
        // creates the property enumerable first. `defineProperty` with a
        // PARTIAL descriptor would preserve that, so `enumerable: false` is
        // spelled at every writer — this assertion keeps it spelled.
        //
        // The `delete` is load-bearing: an earlier test in this file already
        // defined the property non-enumerable, and assigning to an existing
        // writable property PRESERVES its descriptor — which is the very
        // mechanism under test. Only a fresh property is born enumerable.
        const g = globalThis as { __SIGX_SERVERFN_CODEC__?: unknown };
        delete g.__SIGX_SERVERFN_CODEC__;
        g.__SIGX_SERVERFN_CODEC__ = [];
        expect(descriptor('__SIGX_SERVERFN_CODEC__')?.enumerable).toBe(true);

        registerWireTypeHandlers([]);
        expect(descriptor('__SIGX_SERVERFN_CODEC__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_SERVERFN_CODEC__');
    });

    it('the seams still read back through their accessors', () => {
        // Non-enumerable must not mean unreadable — the whole contract is that
        // a reader in another package finds the value exactly as before.
        const config = { authorize: (): boolean => true };
        stampServerAppConfig(config);
        expect(resolveServerAppConfig()).toBe(config);
    });
});
