import { describe, it, expect, vi, afterEach } from 'vitest';
import { effect, effectScope, signal } from '../src/index';
import type { EffectScope } from '../src/index';
import { deepTrack } from '../src/internals';

/**
 * The `/internals` seam for the deep traversal (#651).
 *
 * `watch.test.ts` covers what `deep: true` means; this file covers the thing
 * that makes it reachable to a caller that cannot use `watch` — `@sigx/actors`
 * needs a `scheduler`, which `WatchOptions` does not offer, so it drives the
 * traversal from a bare `effect` and folds the parked re-run at a turn
 * boundary. Every test below is written in exactly that shape, because a seam
 * tested in a shape nobody uses is a seam that can break unnoticed.
 */
describe('deepTrack (internals)', () => {
    /**
     * One scope per test, stopped afterwards — subscriptions that outlive
     * their test accumulate across the file and the later assertions stop
     * meaning what they say.
     *
     * A scope rather than stopping each runner by hand because that is the
     * caller's own teardown: `@sigx/actors` installs the effect inside the
     * activation's `effectScope` and disposes it with `scope.stop()` at
     * deactivation.
     */
    let scope: EffectScope | null = null;

    afterEach(() => {
        scope?.stop();
        scope = null;
    });

    /** The `@sigx/actors` shape: park the re-run, fold it later. */
    function trackDeferred(state: object): { dirty: () => boolean; fold: () => void } {
        let dirty = false;
        let retrack: (() => void) | null = null;
        scope ??= effectScope();
        scope.run(() => {
            effect(() => deepTrack(state), {
                scheduler: (run) => {
                    dirty = true;
                    retrack = run;
                }
            });
        });
        return {
            dirty: () => dirty,
            fold: () => {
                dirty = false;
                const run = retrack;
                retrack = null;
                run?.();
            }
        };
    }

    it('is exported from @sigx/reactivity/internals', () => {
        expect(typeof deepTrack).toBe('function');
    });

    it('schedules the effect on a nested write', () => {
        const state = signal({ rows: [{ nested: { a: 0 } }] });
        const tracking = trackDeferred(state);
        expect(tracking.dirty()).toBe(false);

        state.rows[0]!.nested.a = 1;
        expect(tracking.dirty()).toBe(true);
    });

    it('subscribes an object whose keys are never read', () => {
        // The any-write dep of #644, from the outside: the traversal reads no
        // key through the `get` trap, so `undefined` -> `undefined` on a fresh
        // key must still notify. Per-key deps could not see this at all — the
        // `Object.is` guard compares undefined to undefined and tells nobody.
        const state = signal({ nested: {} as Record<string, unknown> });
        const tracking = trackDeferred(state);

        state.nested.fresh = undefined;
        expect(tracking.dirty()).toBe(true);
    });

    it('re-tracking picks up an object added since the last walk', () => {
        // The case the caller exists for. An object added in one turn and
        // mutated in the next is untracked until the walk re-runs, and under
        // write-behind persistence a missed mutation is lost data.
        const state = signal({ rows: [] as { n: number }[] });
        const tracking = trackDeferred(state);

        state.rows.push({ n: 0 });
        expect(tracking.dirty()).toBe(true);
        tracking.fold();

        // Only the object added by the previous turn is touched here.
        state.rows[0]!.n = 5;
        expect(tracking.dirty()).toBe(true);
    });

    it('covers Map and Set mutations', () => {
        const state = signal({ m: new Map<string, number>(), s: new Set<number>() });
        const viaMap = trackDeferred(state);
        state.m.set('k', 1);
        expect(viaMap.dirty()).toBe(true);

        const fresh = signal({ m: new Map<string, number>(), s: new Set<number>() });
        const viaSet = trackDeferred(fresh);
        fresh.s.add(1);
        expect(viaSet.dirty()).toBe(true);
    });

    it('is a no-op outside an effect', () => {
        // No active subscriber means no dep to allocate. It must not throw —
        // a caller installs tracking lazily and the first call can land
        // anywhere.
        const state = signal({ a: 1 });
        expect(() => deepTrack(state)).not.toThrow();
    });

    it('does not track a plain object, and says so by not notifying', () => {
        // Documented in the JSDoc: subscribing needs a proxy. Pinned so the
        // behaviour is a decision rather than an accident.
        const plain = { a: 1 };
        const runs = vi.fn();
        scope ??= effectScope();
        scope.run(() => {
            effect(() => {
                deepTrack(plain);
                runs();
            });
        });
        expect(runs).toHaveBeenCalledTimes(1);

        plain.a = 2;
        expect(runs).toHaveBeenCalledTimes(1);
    });
});
