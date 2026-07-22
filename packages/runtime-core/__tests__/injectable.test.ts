import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineInjectable, defineProvide, getAppContextToken } from '../src/di/injectable';
import { setCurrentInstance, type ComponentSetupContext } from '../src/component';
import { defineApp } from '../src/app';
import { SigxError } from '../src/errors';

type MockComponentContext = Omit<Partial<ComponentSetupContext>, 'parent'> & {
    provides: Map<any, any>;
    parent?: any;
};

describe('defineInjectable', () => {
    it('should create an injectable function with metadata', () => {
        const factory = () => ({ value: 42 });
        const useService = defineInjectable(factory);

        expect(typeof useService).toBe('function');
        expect(useService._factory).toBe(factory);
        expect(typeof useService._token).toBe('symbol');
    });

    it('should return global singleton when called outside component', () => {
        const useCounter = defineInjectable(() => ({ count: 0 }));

        const instance1 = useCounter();
        const instance2 = useCounter();

        expect(instance1).toBe(instance2);
        expect(instance1.count).toBe(0);
    });

    it('should create unique tokens for different injectables', () => {
        const useService1 = defineInjectable(() => ({}));
        const useService2 = defineInjectable(() => ({}));

        expect(useService1._token).not.toBe(useService2._token);
    });
});

describe('defineProvide', () => {
    let mockInstance: MockComponentContext;

    beforeEach(() => {
        mockInstance = {
            props: {},
            provides: new Map()
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);
    });

    afterEach(() => {
        setCurrentInstance(null);
    });

    it('should create and provide instance using default factory', () => {
        const useService = defineInjectable(() => ({ name: 'default' }));

        const instance = defineProvide(useService);

        expect(instance.name).toBe('default');
        expect(mockInstance.provides.has(useService._token)).toBe(true);
        expect(mockInstance.provides.get(useService._token)).toBe(instance);
    });

    it('should use custom factory when provided', () => {
        const useService = defineInjectable(() => ({ name: 'default' }));
        const customInstance = { name: 'custom' };

        const instance = defineProvide(useService, () => customInstance);

        expect(instance).toBe(customInstance);
        expect(instance.name).toBe('custom');
        expect(mockInstance.provides.get(useService._token)).toBe(customInstance);
    });

    it('should work with injectable that has throwing default factory', () => {
        const useRouter = defineInjectable<{ route: string }>(() => {
            throw new Error('Router not installed');
        });

        const mockRouter = { route: '/home' };

        // This should NOT throw because we provide a custom factory
        const instance = defineProvide(useRouter, () => mockRouter);

        expect(instance).toBe(mockRouter);
        expect(instance.route).toBe('/home');
    });

    it('should throw when called outside component setup', () => {
        setCurrentInstance(null);

        const useService = defineInjectable(() => ({}));

        expect(() => defineProvide(useService)).toThrow(
            'defineProvide must be called inside a component setup function'
        );
    });

    it('should throw when called with invalid injectable', () => {
        const invalidFn = (() => ({})) as any;

        expect(() => defineProvide(invalidFn)).toThrow(
            'defineProvide must be called with a function created by defineInjectable'
        );
    });

    it('should create provides Map if not present on component', () => {
        const instanceWithoutProvides: Record<string, any> = { props: {} };
        setCurrentInstance(instanceWithoutProvides as ComponentSetupContext);

        const useService = defineInjectable(() => ({ value: 1 }));
        defineProvide(useService);

        expect(instanceWithoutProvides.provides).toBeInstanceOf(Map);
    });
});

describe('injectable lookup', () => {
    afterEach(() => {
        setCurrentInstance(null);
    });

    it('should find provided value from current component', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useService = defineInjectable(() => ({ name: 'global' }));
        defineProvide(useService, () => ({ name: 'provided' }));

        const result = useService();
        expect(result.name).toBe('provided');
    });

    it('should traverse parent chain to find provided value', () => {
        const useService = defineInjectable(() => ({ name: 'global' }));

        // Create parent with provided value
        const parentInstance: MockComponentContext = {
            props: {},
            provides: new Map([[useService._token, { name: 'from-parent' }]]),
            parent: null
        };

        // Create child without provided value
        const childInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: parentInstance
        };

        setCurrentInstance(childInstance as ComponentSetupContext);

        const result = useService();
        expect(result.name).toBe('from-parent');
    });

    it('should fall back to global singleton when not provided', () => {
        const useService = defineInjectable(() => ({ name: 'global-singleton' }));

        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        // No defineProvide called, should get global singleton
        const result = useService();
        expect(result.name).toBe('global-singleton');
    });

    it('explicitly provided undefined shadows the global fallback', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useValue = defineInjectable<string | undefined>(() => 'fallback');
        defineProvide(useValue, () => undefined);

        expect(useValue()).toBeUndefined();
    });
});

describe('required injectables (defineInjectable(name))', () => {
    afterEach(() => {
        setCurrentInstance(null);
    });

    it('throws SIGX202 naming the injectable when used unprovided', () => {
        const useRouter = defineInjectable<{ route: string }>('Router');

        let caught: unknown;
        try {
            useRouter();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SigxError);
        expect((caught as SigxError).code).toBe('SIGX202');
        expect((caught as SigxError).message).toContain('"Router"');
    });

    it('throws unprovided inside a component too (no singleton fallback)', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useRouter = defineInjectable<{ route: string }>('Router');
        expect(() => useRouter()).toThrow('Injectable "Router" was used without being provided.');
    });

    it('resolves normally when provided', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useRouter = defineInjectable<{ route: string }>('Router');
        const router = { route: '/home' };
        defineProvide(useRouter, () => router);

        expect(useRouter()).toBe(router);
    });

    it('defineProvide without an explicit factory throws the same named error', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useRouter = defineInjectable<{ route: string }>('Router');
        expect(() => defineProvide(useRouter)).toThrow('Injectable "Router" was used without being provided.');
    });

    it('carries the name as the token description', () => {
        const useRouter = defineInjectable<object>('Router');
        expect(useRouter._token.description).toBe('Router');
    });

    // #404: a pack whose injectable is satisfied by rendering something must be
    // able to say so — the generated `defineProvide` advice is wrong for it.
    it('a hint replaces the generated suggestion, keeping the SIGX202 code and name', () => {
        const useScreen = defineInjectable<object>('Screen', {
            hint: 'Render the component as a route inside <Stack>.',
        });

        let caught: unknown;
        try {
            useScreen();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SigxError);
        expect((caught as SigxError).code).toBe('SIGX202');
        expect((caught as SigxError).message).toContain('"Screen"');
        expect((caught as SigxError).suggestion).toBe('Render the component as a route inside <Stack>.');
        expect((caught as SigxError).suggestion).not.toContain('defineProvide');
    });

    it('the hint reaches the defineProvide-without-factory throw too', () => {
        const mockInstance: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: null
        };
        setCurrentInstance(mockInstance as ComponentSetupContext);

        const useScreen = defineInjectable<object>('Screen', { hint: 'Mount <Stack>.' });
        let caught: unknown;
        try {
            defineProvide(useScreen);
        } catch (e) {
            caught = e;
        }
        expect((caught as SigxError).suggestion).toBe('Mount <Stack>.');
    });

    it('carries neither hint nor suggestion in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const useScreen = defineInjectable<object>('Screen', { hint: 'Mount <Stack>.' });
            let caught: unknown;
            try {
                useScreen();
            } catch (e) {
                caught = e;
            }
            expect((caught as SigxError).code).toBe('SIGX202');
            expect((caught as SigxError).suggestion).toBeUndefined();
            expect((caught as SigxError).message).not.toContain('Mount <Stack>.');
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('app-level provides (live lookup through the root AppContext)', () => {
    afterEach(() => {
        setCurrentInstance(null);
    });

    function treeInApp() {
        const appContext = { provides: new Map<symbol, unknown>() };
        const root: MockComponentContext = {
            props: {},
            provides: new Map([[getAppContextToken(), appContext]]),
            parent: null
        };
        const child: MockComponentContext = {
            props: {},
            provides: new Map(),
            parent: root
        };
        return { appContext, child };
    }

    it('resolves app-level provides added after mount (live read, not a mount-time copy)', () => {
        const { appContext, child } = treeInApp();
        setCurrentInstance(child as ComponentSetupContext);

        const useThing = defineInjectable(() => ({ src: 'global' }));

        // Nothing provided yet: global fallback
        expect(useThing().src).toBe('global');

        // "Post-mount" app-level provide: visible on the next lookup
        const late = { src: 'app' };
        appContext.provides.set(useThing._token, late);
        expect(useThing()).toBe(late);
    });

    it('component-tree provides take precedence over app-level provides', () => {
        const { appContext, child } = treeInApp();
        setCurrentInstance(child as ComponentSetupContext);

        const useThing = defineInjectable(() => ({ src: 'global' }));
        const appValue = { src: 'app' };
        const treeValue = { src: 'tree' };
        appContext.provides.set(useThing._token, appValue);
        child.provides.set(useThing._token, treeValue);

        expect(useThing()).toBe(treeValue);
    });
});

describe('SSR global-fallback warning', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        setCurrentInstance(null);
        vi.restoreAllMocks();
    });

    it('warns once, naming the injectable, when the fallback fires server-side during a component render', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance({ props: {}, provides: new Map(), parent: null } as unknown as ComponentSetupContext);

        const useLeaky = defineInjectable(function leakyService() {
            return { n: 1 };
        });
        useLeaky();
        useLeaky();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('leakyService');
        expect(warn.mock.calls[0][0]).toContain('ALL SSR requests');
    });

    it('warns when the fallback fires inside app.runWithContext (guard / entry-scope code)', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp({} as never);

        const useThing = defineInjectable(function guardService() {
            return { n: 1 };
        });
        app.runWithContext(() => useThing());

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('guardService');
    });

    it('stays silent server-side with no app anywhere (bare script / test)', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const useThing = defineInjectable(() => ({}));
        useThing();

        expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent when the injectable is provided', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance({ props: {}, provides: new Map(), parent: null } as unknown as ComponentSetupContext);

        const useThing = defineInjectable(() => ({ src: 'global' }));
        defineProvide(useThing, () => ({ src: 'provided' }));
        useThing();

        expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent on the client (window defined)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance({ props: {}, provides: new Map(), parent: null } as unknown as ComponentSetupContext);

        const useThing = defineInjectable(() => ({}));
        useThing();

        expect(warn).not.toHaveBeenCalled();
    });

    // #404: inline arrow factories have no `.name`, so without these two the
    // warning names the literal string "sigx:injectable" and can't be acted on.
    it('names the injectable from the { name } option', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance({ props: {}, provides: new Map(), parent: null } as unknown as ComponentSetupContext);

        const useThing = defineInjectable(() => ({}), { name: 'sessionStore' });
        useThing();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('sessionStore');
    });

    it('points at the definition site of an anonymous factory', () => {
        vi.stubGlobal('window', undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance({ props: {}, provides: new Map(), parent: null } as unknown as ComponentSetupContext);

        const useThing = defineInjectable(() => ({}));
        useThing();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/defined at .*injectable\.test\.ts:\d+:\d+/);
    });
});
