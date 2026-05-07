import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineInjectable, defineProvide } from '../src/di/injectable';
import { setCurrentInstance, type ComponentSetupContext } from '../src/component';

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
});
