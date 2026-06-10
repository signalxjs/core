import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineFactory, SubscriptionHandler } from '../src/di/factory';
import { defineProvide } from '../src/di/injectable';
import { setCurrentInstance, type ComponentSetupContext } from '../src/component';
import { defineApp } from '../src/app';

// Partially mock component.js: onUnmounted becomes observable while
// getCurrentInstance/setCurrentInstance keep their real module state
// (injectable.ts depends on them for provide/inject traversal).
vi.mock('../src/component.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/component.js')>();
    return { ...actual, onUnmounted: vi.fn() };
});

import { onUnmounted } from '../src/component';

type MockComponentContext = {
    provides?: Map<symbol, unknown>;
    parent?: MockComponentContext | null;
};

/** A fake component node whose provides chain ends at the app's provides. */
function nodeInApp(app: ReturnType<typeof defineApp>, overrides: MockComponentContext = {}): MockComponentContext {
    return { provides: app._context.provides, parent: null, ...overrides };
}

afterEach(() => {
    setCurrentInstance(null);
    vi.clearAllMocks();
});

// ─── SubscriptionHandler ────────────────────────────────────────────────────

describe('SubscriptionHandler', () => {
    let handler: SubscriptionHandler;

    beforeEach(() => {
        handler = new SubscriptionHandler();
    });

    it('add() stores unsub functions', () => {
        const unsub = vi.fn();
        handler.add(unsub);
        handler.unsubscribe();
        expect(unsub).toHaveBeenCalledOnce();
    });

    it('unsubscribe() calls all stored functions', () => {
        const unsub1 = vi.fn();
        const unsub2 = vi.fn();
        handler.add(unsub1);
        handler.add(unsub2);

        handler.unsubscribe();

        expect(unsub1).toHaveBeenCalledOnce();
        expect(unsub2).toHaveBeenCalledOnce();
    });

    it('unsubscribe() clears the list (idempotent)', () => {
        const unsub = vi.fn();
        handler.add(unsub);

        handler.unsubscribe();
        handler.unsubscribe();

        expect(unsub).toHaveBeenCalledOnce();
    });
});

// ─── defineFactory: setup context & dispose ─────────────────────────────────

describe('defineFactory setup context', () => {
    it('passes SetupFactoryContext as first arg to setup', () => {
        const setup = vi.fn((_ctx: any) => ({}));
        const useThing = defineFactory(setup, 'transient');
        useThing();

        const ctx = setup.mock.calls[0][0];
        expect(typeof ctx.onDeactivated).toBe('function');
        expect(typeof ctx.overrideDispose).toBe('function');
        expect(ctx.subscriptions).toBeInstanceOf(SubscriptionHandler);
    });

    it('passes additional args after context', () => {
        const setup = vi.fn((_ctx: any, a: number, b: string) => ({ a, b }));
        const useThing = defineFactory(setup, 'transient');

        const result = useThing(10, 'hello');

        expect(setup.mock.calls[0][1]).toBe(10);
        expect(setup.mock.calls[0][2]).toBe('hello');
        expect(result.a).toBe(10);
        expect(result.b).toBe('hello');
    });

    it('dispose() runs onDeactivated callbacks and subscriptions', () => {
        const deactivated = vi.fn();
        let capturedCtx: any;
        const useThing = defineFactory((ctx) => {
            capturedCtx = ctx;
            ctx.onDeactivated(deactivated);
            return {};
        }, 'transient');

        const result = useThing();
        const unsubSpy = vi.spyOn(capturedCtx.subscriptions, 'unsubscribe');

        result.dispose();

        expect(deactivated).toHaveBeenCalledOnce();
        expect(unsubSpy).toHaveBeenCalledOnce();
    });

    it('dispose() delegates to a setup-returned dispose without recursing', () => {
        const innerDispose = vi.fn();
        const useThing = defineFactory(() => ({ dispose: innerDispose }), 'transient');

        const result = useThing();
        result.dispose();

        expect(innerDispose).toHaveBeenCalledOnce();
    });

    it('dispose() is idempotent', () => {
        const deactivated = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.onDeactivated(deactivated);
            return {};
        }, 'transient');

        const result = useThing();
        result.dispose();
        result.dispose();

        expect(deactivated).toHaveBeenCalledOnce();
    });

    it('preserves accessor getters on the returned instance (no spread snapshot)', () => {
        let reads = 0;
        const useThing = defineFactory(() => ({
            get total() {
                return ++reads;
            }
        }), 'transient');

        const result = useThing();

        expect(result.total).toBe(1);
        expect(result.total).toBe(2);
    });

    it('throws when setup returns a primitive', () => {
        const usePrimitive = defineFactory((() => 42) as any, 'transient');
        expect(() => usePrimitive()).toThrow(/must return an object or function/);

        const useNull = defineFactory((() => null) as any, 'transient');
        expect(() => useNull()).toThrow(/must return an object or function/);
    });

    it('attaches dispose to function-valued setup results', () => {
        const deactivated = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.onDeactivated(deactivated);
            const callable = () => 42;
            return callable;
        }, 'transient');

        const result = useThing();

        expect(result()).toBe(42);
        expect(typeof result.dispose).toBe('function');
        result.dispose();
        expect(deactivated).toHaveBeenCalledOnce();
    });

    it('dispose is non-enumerable on the instance', () => {
        const useThing = defineFactory(() => ({ value: 1 }), 'transient');
        const result = useThing();

        expect(typeof result.dispose).toBe('function');
        expect(Object.keys(result)).toEqual(['value']);
        expect({ ...result }).not.toHaveProperty('dispose');
    });

    it('overrideDispose() suppresses auto-registration and receives dispose', () => {
        const customRegistration = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.overrideDispose(customRegistration);
            return {};
        }, 'transient');

        useThing();

        expect(onUnmounted).not.toHaveBeenCalled();
        expect(customRegistration).toHaveBeenCalledOnce();
        expect(typeof customRegistration.mock.calls[0][0]).toBe('function');
    });
});

// ─── transient lifetime ─────────────────────────────────────────────────────

describe("lifetime: 'transient'", () => {
    it('creates a new instance per call', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'transient');

        const a = useThing();
        const b = useThing();

        expect(a).not.toBe(b);
        expect(a.id).not.toBe(b.id);
    });

    it('registers caller-owned disposal via onUnmounted per instance', () => {
        const useThing = defineFactory(() => ({}), 'transient');

        useThing();
        useThing();

        expect(onUnmounted).toHaveBeenCalledTimes(2);
        expect(typeof (onUnmounted as any).mock.calls[0][0]).toBe('function');
    });

    it('lifetime does not depend on whether setup takes parameters', () => {
        const withParams = defineFactory((_ctx, n: number) => ({ n, id: {} }), 'transient');
        const withoutParams = defineFactory(() => ({ id: {} }), 'transient');

        expect(withParams(1)).not.toBe(withParams(1));
        expect(withoutParams()).not.toBe(withoutParams());
    });
});

// ─── singleton lifetime ─────────────────────────────────────────────────────

describe("lifetime: 'singleton'", () => {
    it('returns one instance per app context', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        const a = useThing();
        const b = useThing();

        expect(a).toBe(b);
    });

    it('different app contexts get different instances', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');
        const app1 = defineApp({} as any);
        const app2 = defineApp({} as any);

        setCurrentInstance(nodeInApp(app1) as ComponentSetupContext);
        const a = useThing();

        setCurrentInstance(nodeInApp(app2) as ComponentSetupContext);
        const b = useThing();

        expect(a).not.toBe(b);
    });

    it('app-owned singletons are NOT registered with the resolving component', () => {
        const useThing = defineFactory(() => ({}), 'singleton');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        useThing();

        expect(onUnmounted).not.toHaveBeenCalled();
    });

    it('app.unmount() disposes app-owned singletons', () => {
        const deactivated = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.onDeactivated(deactivated);
            return {};
        }, 'singleton');

        const app = defineApp({} as any);
        app.mount({} as any, () => () => { /* platform unmount */ });

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        useThing();
        setCurrentInstance(null);

        expect(deactivated).not.toHaveBeenCalled();
        app.unmount();
        expect(deactivated).toHaveBeenCalledOnce();
    });

    it('parameterized singleton: first creation wins', () => {
        const setup = vi.fn((_ctx: any, n: number) => ({ n }));
        const useThing = defineFactory(setup, 'singleton');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        const a = useThing(1);
        const b = useThing(2);

        expect(setup).toHaveBeenCalledOnce();
        expect(a).toBe(b);
        expect(a.n).toBe(1);
    });

    it('falls back to one realm instance outside any app context', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');

        const a = useThing();
        const b = useThing();

        expect(a).toBe(b);
    });
});

// ─── scoped lifetime ────────────────────────────────────────────────────────

describe("lifetime: 'scoped'", () => {
    it('resolves the nearest provided instance via the component tree', () => {
        const useThing = defineFactory(() => ({ origin: 'app' }), 'scoped');
        const app = defineApp({} as any);

        // Provider component between root and child
        const root = nodeInApp(app);
        const provider: MockComponentContext = { provides: new Map(), parent: root };
        const child: MockComponentContext = { provides: new Map(), parent: provider };

        setCurrentInstance(provider as ComponentSetupContext);
        const providedInstance = defineProvide(useThing as any, () => ({ origin: 'provider' }));

        setCurrentInstance(child as ComponentSetupContext);
        const resolved = useThing();

        expect(resolved).toBe(providedInstance);
        expect((resolved as any).origin).toBe('provider');
    });

    it('falls back to the app-context instance when no provider exists', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'scoped');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        const a = useThing();
        const b = useThing();

        expect(a).toBe(b);
    });

    it('provider-owned instances are disposed when the provider unmounts', () => {
        const deactivated = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.onDeactivated(deactivated);
            return {};
        }, 'scoped');

        const provider: MockComponentContext = { provides: new Map(), parent: null };
        setCurrentInstance(provider as ComponentSetupContext);
        defineProvide(useThing as any);

        // defineProvide registered the disposal with the provider component
        expect(onUnmounted).toHaveBeenCalledOnce();
        const unmountHook = (onUnmounted as any).mock.calls[0][0];

        unmountHook();
        expect(deactivated).toHaveBeenCalledOnce();
    });
});

// ─── disposed-instance recovery ─────────────────────────────────────────────

describe('disposed singleton recovery', () => {
    it('realm fallback recreates the instance after manual dispose()', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');

        const a = useThing();
        a.dispose();

        const b = useThing();
        expect(b).not.toBe(a);
        expect(useThing()).toBe(b);
    });

    it('app-context singleton recreates after manual dispose()', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        const a = useThing();
        a.dispose();

        const b = useThing();
        expect(b).not.toBe(a);
        expect(useThing()).toBe(b);
    });

    it('dispose/recreate cycles do not grow the app disposables set', () => {
        const useThing = defineFactory(() => ({ id: {} }), 'singleton');
        const app = defineApp({} as any);

        setCurrentInstance(nodeInApp(app) as ComponentSetupContext);
        for (let i = 0; i < 5; i++) {
            useThing().dispose();
        }
        useThing();

        expect(app._context.disposables.size).toBe(1);
    });
});

// ─── defineProvide integration ──────────────────────────────────────────────

describe('defineProvide with factory-made functions', () => {
    it('factory use-functions carry _token and _factory metadata', () => {
        const useThing = defineFactory(() => ({ value: 1 }), 'scoped');

        expect(typeof (useThing as any)._token).toBe('symbol');
        expect(typeof (useThing as any)._factory).toBe('function');
    });

    it('app.defineProvide provides and app.unmount disposes the instance', () => {
        const deactivated = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.onDeactivated(deactivated);
            return {};
        }, 'scoped');

        const app = defineApp({} as any);
        app.mount({} as any, () => () => { /* platform unmount */ });
        const instance = app.defineProvide(useThing);

        expect(app._context.provides.get(useThing._token)).toBe(instance);

        app.unmount();
        expect(deactivated).toHaveBeenCalledOnce();
    });

    it('parameterized factories carry provide metadata in their types', () => {
        const useThing = defineFactory((_ctx, label: string) => ({ label }), 'scoped');

        // compiles without casts: FactoryFunction includes _factory/_token
        const provider: MockComponentContext = { provides: new Map(), parent: null };
        setCurrentInstance(provider as ComponentSetupContext);
        const instance = defineProvide(useThing);

        expect(instance.label).toBeUndefined(); // args-less creation via _factory
        expect(provider.provides!.has(useThing._token)).toBe(true);
    });

    it('overrideDispose is honored through defineProvide (custom registration, no auto-register)', () => {
        const customRegistration = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.overrideDispose(customRegistration);
            return {};
        }, 'scoped');

        const provider: MockComponentContext = { provides: new Map(), parent: null };
        setCurrentInstance(provider as ComponentSetupContext);
        defineProvide(useThing);

        expect(customRegistration).toHaveBeenCalledOnce();
        expect(typeof customRegistration.mock.calls[0][0]).toBe('function');
        // defineProvide must NOT also register provider-owned disposal
        expect(onUnmounted).not.toHaveBeenCalled();
    });

    it('overrideDispose is honored through app.defineProvide (no app disposable)', () => {
        const customRegistration = vi.fn();
        const useThing = defineFactory((ctx) => {
            ctx.overrideDispose(customRegistration);
            return {};
        }, 'scoped');

        const app = defineApp({} as any);
        app.defineProvide(useThing);

        expect(customRegistration).toHaveBeenCalledOnce();
        expect(app._context.disposables.size).toBe(0);
    });
});
