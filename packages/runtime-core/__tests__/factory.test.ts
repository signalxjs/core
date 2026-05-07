import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineFactory, SubscriptionHandler } from '../src/di/factory';
import { InstanceLifetimes } from '../src/models';

// Mock onUnmounted — it requires a live component context we don't have in unit tests
vi.mock('../src/component.js', () => ({
    onUnmounted: vi.fn()
}));

// Mock defineInjectable so we can verify it's called for parameterless factories
vi.mock('../src/di/injectable.js', () => ({
    defineInjectable: vi.fn((factory: () => unknown) => {
        const fn = () => factory();
        (fn as any)._factory = factory;
        (fn as any)._token = Symbol();
        return fn;
    })
}));

import { onUnmounted } from '../src/component';
import { defineInjectable } from '../src/di/injectable';

// ─── SubscriptionHandler ────────────────────────────────────────────────────

describe('SubscriptionHandler', () => {
    let handler: SubscriptionHandler;

    beforeEach(() => {
        handler = new SubscriptionHandler();
    });

    it('add() stores unsub functions', () => {
        const unsub = vi.fn();
        handler.add(unsub);
        // Calling unsubscribe should invoke the stored function
        handler.unsubscribe();
        expect(unsub).toHaveBeenCalledOnce();
    });

    it('unsubscribe() calls all stored functions', () => {
        const unsub1 = vi.fn();
        const unsub2 = vi.fn();
        const unsub3 = vi.fn();
        handler.add(unsub1);
        handler.add(unsub2);
        handler.add(unsub3);

        handler.unsubscribe();

        expect(unsub1).toHaveBeenCalledOnce();
        expect(unsub2).toHaveBeenCalledOnce();
        expect(unsub3).toHaveBeenCalledOnce();
    });

    it('unsubscribe() clears the list (idempotent)', () => {
        const unsub = vi.fn();
        handler.add(unsub);

        handler.unsubscribe();
        handler.unsubscribe(); // second call should be a no-op

        expect(unsub).toHaveBeenCalledOnce();
    });

    it('handles multiple add + unsubscribe cycles', () => {
        const first = vi.fn();
        handler.add(first);
        handler.unsubscribe();

        const second = vi.fn();
        handler.add(second);
        handler.unsubscribe();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
    });
});

// ─── defineFactory ──────────────────────────────────────────────────────────

describe('defineFactory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a factory function that calls setup', () => {
        const setup = vi.fn((_ctx) => ({ value: 42 }));
        // setup.length === 1 → injectable path, but setup is still called
        const injectable = defineFactory(setup, InstanceLifetimes.Transient);

        // Calling the injectable invokes setup
        const result = (injectable as any)();
        expect(setup).toHaveBeenCalledOnce();
        expect(result).toHaveProperty('value', 42);
    });

    it('passes SetupFactoryContext as first arg to setup', () => {
        const setup = vi.fn((_ctx) => ({}));
        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        (injectable as any)();

        const ctx = setup.mock.calls[0][0];
        expect(ctx).toHaveProperty('onDeactivated');
        expect(ctx).toHaveProperty('subscriptions');
        expect(ctx).toHaveProperty('overrideDispose');
        expect(typeof ctx.onDeactivated).toBe('function');
        expect(typeof ctx.overrideDispose).toBe('function');
        expect(ctx.subscriptions).toBeInstanceOf(SubscriptionHandler);
    });

    it('passes additional args after context', () => {
        // setup with 3 declared params → setup.length === 3 → returns plain function
        const setup = vi.fn((_ctx: any, a: number, b: string) => ({ a, b }));
        const factory = defineFactory(setup, InstanceLifetimes.Transient) as any;

        const result = factory(10, 'hello');

        expect(setup).toHaveBeenCalledOnce();
        expect(setup.mock.calls[0][1]).toBe(10);
        expect(setup.mock.calls[0][2]).toBe('hello');
        expect(result).toHaveProperty('a', 10);
        expect(result).toHaveProperty('b', 'hello');
    });

    it('returned object is spread result + dispose', () => {
        const setup = vi.fn((_ctx) => ({ foo: 'bar', count: 7 }));
        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        const result = (injectable as any)();

        expect(result.foo).toBe('bar');
        expect(result.count).toBe(7);
        expect(typeof result.dispose).toBe('function');
    });

    it('dispose() calls onDeactivated callbacks', () => {
        const deactivated1 = vi.fn();
        const deactivated2 = vi.fn();

        const setup = vi.fn((ctx) => {
            ctx.onDeactivated(deactivated1);
            ctx.onDeactivated(deactivated2);
            return {};
        });

        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        const result = (injectable as any)();

        expect(deactivated1).not.toHaveBeenCalled();
        expect(deactivated2).not.toHaveBeenCalled();

        result.dispose();

        expect(deactivated1).toHaveBeenCalledOnce();
        expect(deactivated2).toHaveBeenCalledOnce();
    });

    it('dispose() calls subscriptions.unsubscribe()', () => {
        let capturedCtx: any;
        const setup = vi.fn((ctx) => {
            capturedCtx = ctx;
            return {};
        });

        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        const result = (injectable as any)();

        const unsubSpy = vi.spyOn(capturedCtx.subscriptions, 'unsubscribe');
        result.dispose();

        expect(unsubSpy).toHaveBeenCalledOnce();
    });

    it('dispose() calls result.dispose if it exists', () => {
        const innerDispose = vi.fn();
        const setup = vi.fn((_ctx) => ({ dispose: innerDispose }));

        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        const result = (injectable as any)();

        result.dispose();

        expect(innerDispose).toHaveBeenCalledOnce();
    });

    it('dispose() does NOT call result.dispose if result has no dispose', () => {
        const setup = vi.fn((_ctx) => ({ value: 1 }));
        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        const result = (injectable as any)();

        // Should not throw
        expect(() => result.dispose()).not.toThrow();
    });

    it('overrideDispose() provides custom dispose registration', () => {
        const customRegistration = vi.fn();

        const setup = vi.fn((ctx) => {
            ctx.overrideDispose(customRegistration);
            return { value: 1 };
        });

        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        (injectable as any)();

        // When overrideDispose is used, onUnmounted should NOT be called
        expect(onUnmounted).not.toHaveBeenCalled();
        // The custom registration receives the dispose function
        expect(customRegistration).toHaveBeenCalledOnce();
        expect(typeof customRegistration.mock.calls[0][0]).toBe('function');

        // Calling the provided dispose function should trigger cleanup
        const deactivated = vi.fn();
        const setup2 = vi.fn((ctx) => {
            ctx.onDeactivated(deactivated);
            ctx.overrideDispose((_disposeFn: () => void) => {
                // Store it but don't call yet
                _disposeFn();
            });
            return {};
        });
        const injectable2 = defineFactory(setup2, InstanceLifetimes.Transient);
        (injectable2 as any)();
        expect(deactivated).toHaveBeenCalledOnce();
    });

    it('parameterless factory (setup.length <= 1) returns injectable', () => {
        // setup.length === 1 (only ctx param)
        const setup = (_ctx: any) => ({ data: 'test' });
        defineFactory(setup, InstanceLifetimes.Singleton);

        expect(defineInjectable).toHaveBeenCalledOnce();
        expect(typeof (defineInjectable as any).mock.calls[0][0]).toBe('function');
    });

    it('factory with params (setup.length > 1) returns plain function', () => {
        // setup.length === 2 → should NOT call defineInjectable
        const setup = (_ctx: any, _param: string) => ({ data: 'test' });
        const result = defineFactory(setup, InstanceLifetimes.Transient);

        expect(defineInjectable).not.toHaveBeenCalled();
        expect(typeof result).toBe('function');
    });

    it('registers onUnmounted when no custom dispose is set', () => {
        const setup = vi.fn((_ctx) => ({ value: 1 }));
        const injectable = defineFactory(setup, InstanceLifetimes.Transient);
        (injectable as any)();

        expect(onUnmounted).toHaveBeenCalledOnce();
        expect(typeof (onUnmounted as any).mock.calls[0][0]).toBe('function');
    });
});
