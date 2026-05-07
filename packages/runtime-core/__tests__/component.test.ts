import { describe, it, expect, vi } from 'vitest';
import { component, getCurrentInstance, setCurrentInstance } from '../src/component';
import { VNode } from '../src/jsx-runtime';

describe('component', () => {
    it('should create a component factory', () => {
        const TestComponent = component(() => {
            return () => null;
        });

        expect(typeof TestComponent).toBe('function');
        expect(TestComponent.__setup).toBeDefined();
    });

    it('should store the setup function on __setup', () => {
        const setup = vi.fn(() => () => null);
        const TestComponent = component(setup);

        expect(TestComponent.__setup).toBe(setup);
    });

    it('should store the component name when provided', () => {
        const TestComponent = component(() => () => null, { name: 'TestComponent' });

        expect(TestComponent.__name).toBe('TestComponent');
    });

    it('should return a VNode-like structure when called', () => {
        const TestComponent = component(() => () => null);
        const result = TestComponent({ prop: 'value' } as any) as VNode;

        expect(result.type).toBe(TestComponent);
        expect(result.props.prop).toBe('value');
    });

    it('should handle key prop', () => {
        const TestComponent = component(() => () => null);
        const result = TestComponent({ key: 'my-key' } as any) as VNode;

        expect(result.key).toBe('my-key');
    });
});

describe('getCurrentInstance / setCurrentInstance', () => {
    it('should return null when no instance is set', () => {
        expect(getCurrentInstance()).toBeNull();
    });

    it('should return the current instance when set', () => {
        const mockInstance = { props: {}, signal: vi.fn() } as any;

        const prev = setCurrentInstance(mockInstance);
        expect(getCurrentInstance()).toBe(mockInstance);

        setCurrentInstance(prev);
        expect(getCurrentInstance()).toBeNull();
    });

    it('should return the previous instance when setting a new one', () => {
        const instance1 = { id: 1 } as any;
        const instance2 = { id: 2 } as any;

        const prev1 = setCurrentInstance(instance1);
        expect(prev1).toBeNull();

        const prev2 = setCurrentInstance(instance2);
        expect(prev2).toBe(instance1);

        expect(getCurrentInstance()).toBe(instance2);

        // Cleanup
        setCurrentInstance(null);
    });
});
