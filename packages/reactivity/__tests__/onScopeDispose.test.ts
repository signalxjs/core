import { describe, it, expect, vi } from 'vitest';
import { effectScope, onScopeDispose } from '../src/index';
import { collectSetupScope, takeSetupDisposers } from '../src/effect';

/**
 * Tests for onScopeDispose (core#296) — the public registration path for
 * arbitrary (non-effect) teardown: event listeners, timers, observers.
 * Ecosystem composables (@sigx/use) tie resource lifetime to the owning
 * scope through this.
 */
describe('onScopeDispose', () => {
    it('runs the disposer when the owning effectScope stops', () => {
        const dispose = vi.fn();
        const scope = effectScope();

        let registered: boolean | undefined;
        scope.run(() => {
            registered = onScopeDispose(dispose);
        });

        expect(registered).toBe(true);
        expect(dispose).not.toHaveBeenCalled();

        scope.stop();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('registers with the innermost scope when scopes nest', () => {
        const outerDispose = vi.fn();
        const innerDispose = vi.fn();
        const outer = effectScope();

        outer.run(() => {
            onScopeDispose(outerDispose);
            const inner = effectScope();
            inner.run(() => {
                onScopeDispose(innerDispose);
            });
            inner.stop();
        });

        expect(innerDispose).toHaveBeenCalledTimes(1);
        expect(outerDispose).not.toHaveBeenCalled();

        outer.stop();
        expect(outerDispose).toHaveBeenCalledTimes(1);
        expect(innerDispose).toHaveBeenCalledTimes(1); // not re-run
    });

    it('is captured by collectSetupScope (component setup lifetime)', () => {
        const dispose = vi.fn();

        let registered: boolean | undefined;
        collectSetupScope(() => {
            registered = onScopeDispose(dispose);
        });

        expect(registered).toBe(true);
        const disposers = takeSetupDisposers();
        expect(disposers).toHaveLength(1);

        disposers![0]();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('returns false and retains nothing when no scope is active', () => {
        const dispose = vi.fn();

        expect(onScopeDispose(dispose)).toBe(false);

        // A scope created and stopped afterwards must not pick it up.
        const scope = effectScope();
        scope.run(() => {});
        scope.stop();
        expect(dispose).not.toHaveBeenCalled();
    });

    it('runs multiple disposers in registration order', () => {
        const order: number[] = [];
        const scope = effectScope();

        scope.run(() => {
            onScopeDispose(() => order.push(1));
            onScopeDispose(() => order.push(2));
            onScopeDispose(() => order.push(3));
        });

        scope.stop();
        expect(order).toEqual([1, 2, 3]);
    });
});
