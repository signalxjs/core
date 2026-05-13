import { describe, it, expect, vi } from 'vitest';
import {
    createModel,
    createModelFromBinding,
    isModel,
    getModelSymbol
} from '../src/model';

describe('isModel — edge cases', () => {
    it('returns false for null', () => {
        expect(isModel(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isModel(undefined)).toBe(false);
    });

    it('returns false for plain object without symbol', () => {
        expect(isModel({})).toBe(false);
        expect(isModel({ value: 1 })).toBe(false);
    });

    it('returns false for primitives', () => {
        expect(isModel(0)).toBe(false);
        expect(isModel('')).toBe(false);
        expect(isModel('hello')).toBe(false);
        expect(isModel(true)).toBe(false);
        expect(isModel(false)).toBe(false);
        expect(isModel(Symbol('x'))).toBe(false);
    });

    it('returns false when symbol value is not true', () => {
        const sym = getModelSymbol();
        const fake = { [sym]: false } as any;
        expect(isModel(fake)).toBe(false);
    });

    it('returns true for object created by createModel', () => {
        const obj = { v: 'x' };
        const model = createModel<string>([obj, 'v'], () => {});
        expect(isModel(model)).toBe(true);
    });
});

describe('createModel', () => {
    it('reads through to the source object', () => {
        const src = { value: 'hello' };
        const handler = vi.fn();
        const model = createModel<string>([src, 'value'], handler);
        expect(model.value).toBe('hello');
        src.value = 'world';
        expect(model.value).toBe('world');
    });

    it('routes writes through the update handler', () => {
        const src = { value: 'a' };
        const handler = vi.fn();
        const model = createModel<string>([src, 'value'], handler);
        model.value = 'b';
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith('b');
        // The handler is responsible for actually mutating; createModel doesn't
        expect(src.value).toBe('a');
    });

    it('exposes a binding tuple of [obj, key, handler]', () => {
        const src = { value: 1 };
        const handler = (n: number) => { src.value = n; };
        const model = createModel<number>([src, 'value'], handler);
        const [obj, key, h] = model.binding;
        expect(obj).toBe(src);
        expect(key).toBe('value');
        expect(h).toBe(handler);
    });
});

describe('createModelFromBinding', () => {
    it('rebuilds an equivalent model from an existing binding', () => {
        const src = { value: 'a' };
        const handler = vi.fn();
        const original = createModel<string>([src, 'value'], handler);
        const forwarded = createModelFromBinding(original.binding);

        expect(isModel(forwarded)).toBe(true);
        expect(forwarded.value).toBe('a');

        forwarded.value = 'b';
        expect(handler).toHaveBeenCalledWith('b');
    });
});

describe('getModelSymbol', () => {
    it('returns the same symbol used to tag Model objects', () => {
        const sym = getModelSymbol();
        const model = createModel<number>([{ x: 0 }, 'x'], () => {});
        expect(sym in model).toBe(true);
        expect((model as any)[sym]).toBe(true);
    });

    it('is registered under the well-known sigx.model key', () => {
        expect(getModelSymbol()).toBe(Symbol.for('sigx.model'));
    });
});
