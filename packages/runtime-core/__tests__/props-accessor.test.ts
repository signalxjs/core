import { describe, it, expect } from 'vitest';
import { createPropsAccessor } from '../src/utils/props-accessor';

describe('createPropsAccessor', () => {
    it('should provide direct property access', () => {
        const props = createPropsAccessor({ name: 'test', count: 42 });

        expect(props.name).toBe('test');
        expect(props.count).toBe(42);
    });

    it('should return undefined for missing props', () => {
        const props = createPropsAccessor({ name: 'test' } as any);

        expect(props.missing).toBeUndefined();
    });

    it('should support destructuring with defaults', () => {
        const props = createPropsAccessor({ name: 'provided' } as Record<string, any>);
        const { name, label = 'default-label' } = props;

        expect(name).toBe('provided');
        expect(label).toBe('default-label');
    });

    it('should support spreading', () => {
        const props = createPropsAccessor({ a: 1, b: 2, c: 3 });
        const spread = { ...props };

        expect(spread).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should support the "in" operator', () => {
        const props = createPropsAccessor({ name: 'test', count: 42 });

        expect('name' in props).toBe(true);
        expect('count' in props).toBe(true);
        expect('missing' in props).toBe(false);
    });

    it('should return correct ownKeys', () => {
        const props = createPropsAccessor({ x: 1, y: 2 });

        expect(Object.keys(props)).toEqual(['x', 'y']);
    });

    it('should be readonly (not writable)', () => {
        const props = createPropsAccessor({ name: 'test' });
        const descriptor = Object.getOwnPropertyDescriptor(props, 'name');

        expect(descriptor?.writable).toBe(false);
    });
});
