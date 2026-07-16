import { describe, it, expect, vi } from 'vitest';
import { signal, effect, watch, computed, effectScope } from '../src/index';
import { collectSetupScope, takeSetupDisposers } from '../src/effect';

/**
 * Tests for the lazy setup-scope collector (core#288). collectSetupScope()
 * captures the effect()/watch()/non-detached effectScope() a component's setup
 * creates so the renderer can dispose them on unmount — with zero allocation
 * when the setup creates no reactions.
 */
describe('collectSetupScope', () => {
    it('returns null (no allocation) when the body creates no reactions', () => {
        const result = collectSetupScope(() => 'render');
        expect(result).toBe('render');
        expect(takeSetupDisposers()).toBeNull();
    });

    it('captures effect() and disposing it stops the effect', () => {
        const s = signal({ n: 0 });
        const seen: number[] = [];

        collectSetupScope(() => {
            effect(() => { seen.push(s.n); });
        });
        const disposers = takeSetupDisposers();
        expect(disposers).toHaveLength(1);

        s.n = 1;                       // still live
        expect(seen).toEqual([0, 1]);

        disposers!.forEach(d => d());  // dispose (what the renderer does on unmount)
        s.n = 2;
        expect(seen).toEqual([0, 1]);  // no further runs
    });

    it('captures watch() and disposing it stops the watcher', () => {
        const s = signal({ n: 0 });
        const cb = vi.fn();

        collectSetupScope(() => {
            watch(() => s.n, cb);
        });
        const disposers = takeSetupDisposers();
        expect(disposers).toHaveLength(1);

        s.n = 1;
        expect(cb).toHaveBeenCalledTimes(1);

        disposers!.forEach(d => d());
        s.n = 2;
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does not capture computed() (lazy, nothing to dispose)', () => {
        collectSetupScope(() => {
            const c = computed(() => 1 + 1);
            void c.value;
        });
        expect(takeSetupDisposers()).toBeNull();
    });

    it('captures a non-detached effectScope() created in the body', () => {
        const s = signal({ n: 0 });
        const seen: number[] = [];

        collectSetupScope(() => {
            const scope = effectScope();       // non-detached
            scope.run(() => { effect(() => { seen.push(s.n); }); });
        });
        const disposers = takeSetupDisposers();
        expect(disposers).toHaveLength(1);     // the scope's stop

        s.n = 1;
        expect(seen).toEqual([0, 1]);
        disposers!.forEach(d => d());          // stops the scope → stops its effect
        s.n = 2;
        expect(seen).toEqual([0, 1]);
    });

    it('lets an explicit effectScope().run() take precedence — its effects are NOT collected', () => {
        const s = signal({ n: 0 });
        const scope = effectScope(true);       // detached: owns its own effect
        const seen: number[] = [];

        collectSetupScope(() => {
            scope.run(() => { effect(() => { seen.push(s.n); }); });
        });
        // The detached scope is not registered anywhere, and its inner effect
        // belongs to it, so the collector captured nothing.
        expect(takeSetupDisposers()).toBeNull();

        s.n = 1;
        expect(seen).toEqual([0, 1]);          // still live (owned by `scope`)
        scope.stop();
        s.n = 2;
        expect(seen).toEqual([0, 1]);
    });

    it('isolates nested collectSetupScope() calls — each region gets only its own disposers', () => {
        const so = signal({ n: 0 });
        const si = signal({ n: 0 });
        const outerRuns: string[] = [];
        const innerRuns: string[] = [];
        let innerDisposers: (() => void)[] | null = null;

        collectSetupScope(() => {
            effect(() => { outerRuns.push('o' + so.n); });   // belongs to outer
            collectSetupScope(() => {
                effect(() => { innerRuns.push('i' + si.n); }); // belongs to inner
            });
            innerDisposers = takeSetupDisposers();           // take inner's immediately
        });
        const outerDisposers = takeSetupDisposers();         // outer's

        expect(innerDisposers).toHaveLength(1);
        expect(outerDisposers).toHaveLength(1);

        // Dispose inner only: its effect stops, the outer's stays live.
        innerDisposers!.forEach(d => d());
        so.n = 1; si.n = 1;
        expect(outerRuns).toEqual(['o0', 'o1']);
        expect(innerRuns).toEqual(['i0']);                   // inner disposed — no i1

        outerDisposers!.forEach(d => d());
        so.n = 2;
        expect(outerRuns).toEqual(['o0', 'o1']);
    });

    it('a throwing body still exposes its partial disposers via takeSetupDisposers()', () => {
        const s = signal({ n: 0 });
        const runs: number[] = [];

        expect(() => collectSetupScope(() => {
            effect(() => { runs.push(s.n); });
            throw new Error('setup-boom');
        })).toThrow('setup-boom');

        // The effect created before the throw is retrievable, so the caller can
        // dispose it instead of leaking it.
        const partial = takeSetupDisposers();
        expect(partial).toHaveLength(1);
        partial!.forEach(d => d());
        s.n = 1;
        expect(runs).toEqual([0]);
    });

    it('takeSetupDisposers() clears after reading', () => {
        collectSetupScope(() => { effect(() => {}); });
        expect(takeSetupDisposers()).toHaveLength(1);
        expect(takeSetupDisposers()).toBeNull();
    });

    it('restores the outer scope: an effect created after the region is unaffected', () => {
        const outer = effectScope();
        const s = signal({ n: 0 });
        const seen: number[] = [];

        outer.run(() => {
            // A setup collector nested inside an active outer scope.
            collectSetupScope(() => { effect(() => { seen.push(s.n); }); });
            const setupDisposers = takeSetupDisposers();
            expect(setupDisposers).toHaveLength(1);
            // After the region, effects register with `outer` again.
            effect(() => { void s.n; });
        });

        // Stopping outer disposes only what it owns (the second effect), not
        // the collected setup effect — prove the setup effect is independent.
        s.n = 1;
        expect(seen).toEqual([0, 1]);
        outer.stop();
        s.n = 2;
        expect(seen).toEqual([0, 1, 2]); // setup effect still live (owned by the collector, not outer)
    });
});
