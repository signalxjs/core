import { describe, it, expect, vi } from 'vitest';
import {
    CLIENT_DIRECTIVE_PREFIX,
    CLIENT_DIRECTIVES,
    filterClientDirectives,
    getHydrationDirective,
    hasClientDirective,
    serializeProps,
    createEmit,
} from '../src/hydration/index';

describe('CLIENT_DIRECTIVE_PREFIX', () => {
    it("is 'client:'", () => {
        expect(CLIENT_DIRECTIVE_PREFIX).toBe('client:');
    });
});

describe('CLIENT_DIRECTIVES', () => {
    it('contains all 5 directives', () => {
        expect(CLIENT_DIRECTIVES).toHaveLength(5);
        expect(CLIENT_DIRECTIVES).toContain('client:load');
        expect(CLIENT_DIRECTIVES).toContain('client:idle');
        expect(CLIENT_DIRECTIVES).toContain('client:visible');
        expect(CLIENT_DIRECTIVES).toContain('client:media');
        expect(CLIENT_DIRECTIVES).toContain('client:only');
    });
});

describe('filterClientDirectives', () => {
    it('removes all client: prefixed props', () => {
        const props = { 'client:load': true, 'client:media': '(min-width: 768px)', name: 'test' };
        const result = filterClientDirectives(props);
        expect(result).toEqual({ name: 'test' });
    });

    it('keeps non-client props', () => {
        const props = { id: '1', className: 'box', title: 'hello' };
        const result = filterClientDirectives(props);
        expect(result).toEqual({ id: '1', className: 'box', title: 'hello' });
    });

    it('works with empty props', () => {
        expect(filterClientDirectives({})).toEqual({});
    });

    it('works with only client props (returns empty object)', () => {
        const props = { 'client:load': true, 'client:idle': true };
        expect(filterClientDirectives(props)).toEqual({});
    });

    it('works with mixed props', () => {
        const props = { 'client:visible': true, foo: 'bar', 'client:only': '', baz: 42 };
        const result = filterClientDirectives(props);
        expect(result).toEqual({ foo: 'bar', baz: 42 });
    });
});

describe('getHydrationDirective', () => {
    it("returns { strategy: 'load' } for client:load", () => {
        expect(getHydrationDirective({ 'client:load': true })).toEqual({ strategy: 'load' });
    });

    it("returns { strategy: 'idle' } for client:idle", () => {
        expect(getHydrationDirective({ 'client:idle': true })).toEqual({ strategy: 'idle' });
    });

    it("returns { strategy: 'visible' } for client:visible", () => {
        expect(getHydrationDirective({ 'client:visible': true })).toEqual({ strategy: 'visible' });
    });

    it("returns { strategy: 'only' } for client:only", () => {
        expect(getHydrationDirective({ 'client:only': true })).toEqual({ strategy: 'only' });
    });

    it("returns { strategy: 'media', media: '(min-width: 768px)' } for client:media", () => {
        expect(getHydrationDirective({ 'client:media': '(min-width: 768px)' })).toEqual({
            strategy: 'media',
            media: '(min-width: 768px)',
        });
    });

    it('returns null when no client directive present', () => {
        expect(getHydrationDirective({ foo: 'bar' })).toBeNull();
        expect(getHydrationDirective({})).toBeNull();
    });

    it('priority: client:load wins over others (first check)', () => {
        const props = { 'client:load': true, 'client:idle': true, 'client:media': '(max-width: 600px)' };
        expect(getHydrationDirective(props)).toEqual({ strategy: 'load' });
    });
});

describe('hasClientDirective', () => {
    it('returns true when client: prop exists', () => {
        expect(hasClientDirective({ 'client:load': true })).toBe(true);
        expect(hasClientDirective({ 'client:media': '(min-width: 768px)', id: '1' })).toBe(true);
    });

    it('returns false when no client: prop exists', () => {
        expect(hasClientDirective({ foo: 'bar', baz: 42 })).toBe(false);
    });

    it('works with empty props', () => {
        expect(hasClientDirective({})).toBe(false);
    });
});

describe('serializeProps', () => {
    it('serializes primitive props (string, number, boolean, null)', () => {
        const props = { str: 'hello', num: 42, bool: true, nil: null };
        expect(serializeProps(props)).toEqual({ str: 'hello', num: 42, bool: true, nil: null });
    });

    it('serializes object props', () => {
        const props = { data: { nested: [1, 2, 3] } };
        expect(serializeProps(props)).toEqual({ data: { nested: [1, 2, 3] } });
    });

    it('filters out client directives', () => {
        const props = { 'client:load': true, name: 'test' };
        expect(serializeProps(props)).toEqual({ name: 'test' });
    });

    it('skips internal props (children, key, ref, slots)', () => {
        const props = { children: [], key: 'k', ref: {}, slots: {}, title: 'hi' };
        expect(serializeProps(props)).toEqual({ title: 'hi' });
    });

    it('skips functions', () => {
        const props = { compute: () => 1, label: 'x' };
        expect(serializeProps(props)).toEqual({ label: 'x' });
    });

    it('skips symbols', () => {
        const props = { sym: Symbol('test'), label: 'x' };
        expect(serializeProps(props)).toEqual({ label: 'x' });
    });

    it('skips undefined values', () => {
        const props = { a: undefined, b: 'defined' };
        expect(serializeProps(props)).toEqual({ b: 'defined' });
    });

    it('skips event handlers (onClick, onSubmit, etc.)', () => {
        const props = { onClick: () => {}, onSubmit: () => {}, label: 'btn' };
        expect(serializeProps(props)).toEqual({ label: 'btn' });
    });

    it('skips non-serializable values (circular refs)', () => {
        const circular: any = {};
        circular.self = circular;
        const props = { bad: circular, good: 'ok' };
        expect(serializeProps(props)).toEqual({ good: 'ok' });
    });

    it('returns undefined when no serializable props remain', () => {
        expect(serializeProps({})).toBeUndefined();
        expect(serializeProps({ onClick: () => {}, children: [] })).toBeUndefined();
        expect(serializeProps({ 'client:load': true })).toBeUndefined();
    });

    it("does NOT skip lowercase 'on' prefix (e.g., 'online' is kept)", () => {
        const props = { online: true, once: 'value' };
        const result = serializeProps(props);
        expect(result).toEqual({ online: true, once: 'value' });
    });
});

describe('createEmit', () => {
    it("calls props.onClick when emit('click') is called", () => {
        const handler = vi.fn();
        const emit = createEmit({ onClick: handler });
        emit('click');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('passes arguments to handler', () => {
        const handler = vi.fn();
        const emit = createEmit({ onClick: handler });
        emit('click', 'arg1', 42);
        expect(handler).toHaveBeenCalledWith('arg1', 42);
    });

    it('works with signal-wrapped props ({value: {...}})', () => {
        const handler = vi.fn();
        const emit = createEmit({ value: { onClick: handler } });
        emit('click');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('works with plain props objects', () => {
        const handler = vi.fn();
        const emit = createEmit({ onSubmit: handler });
        emit('submit', { data: 'test' });
        expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it("no-ops when handler doesn't exist", () => {
        const emit = createEmit({ foo: 'bar' });
        expect(() => emit('click')).not.toThrow();
    });

    it('no-ops when handler is not a function', () => {
        const emit = createEmit({ onClick: 'not-a-function' });
        expect(() => emit('click')).not.toThrow();
    });
});
