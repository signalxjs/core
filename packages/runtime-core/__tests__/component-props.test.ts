/**
 * Component-setup helper tests: createEmit and splitComponentProps
 * (shared between mountComponent and the client hydrator).
 */

import { describe, it, expect, vi } from 'vitest';
import { createEmit, splitComponentProps } from '../src/utils/component-props';
import { createModel } from '../src/model';
import { signal } from '@sigx/reactivity';

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

describe('splitComponentProps', () => {
    it('separates children and slots from data props', () => {
        const slots = { header: () => [] };
        const result = splitComponentProps({ children: 'hi', slots, name: 'x', count: 1 });

        expect(result.children).toBe('hi');
        expect(result.slotsFromProps).toBe(slots);
        expect(result.propsWithModels).toEqual({ name: 'x', count: 1 });
    });

    it('merges only Model values from $models into props', () => {
        const m = createModel([{ v: 1 }, 'v'], () => {});
        const result = splitComponentProps({
            name: 'x',
            $models: { value: m, bogus: { value: 1 } }
        });

        expect(result.propsWithModels.value).toBe(m);
        expect(result.propsWithModels.bogus).toBeUndefined();
        expect(result.propsWithModels.name).toBe('x');
    });

    it('handles empty props', () => {
        const result = splitComponentProps({});
        expect(result.children).toBeUndefined();
        expect(result.slotsFromProps).toBeUndefined();
        expect(result.propsWithModels).toEqual({});
    });
});

describe('createEmit with reactive props', () => {
    it('finds handlers on a reactive props proxy even when a "value" prop exists', () => {
        const handler = vi.fn();
        const reactiveProps = signal({ value: 'input-text', onPing: handler });

        const emit = createEmit(reactiveProps);
        emit('ping', 1);

        expect(handler).toHaveBeenCalledWith(1);
    });
});

describe('splitComponentProps hardening', () => {
    it('never assigns prototype-mutating $models keys', () => {
        const m = createModel([{ v: 1 }, 'v'], () => {});
        const modelsData = Object.defineProperty({ ok: m } as Record<string, any>, '__proto__', {
            value: m,
            enumerable: true
        });

        const result = splitComponentProps({ $models: modelsData });

        expect(result.propsWithModels.ok).toBe(m);
        expect(Object.getPrototypeOf(result.propsWithModels)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(result.propsWithModels, '__proto__')).toBe(false);
    });
});
