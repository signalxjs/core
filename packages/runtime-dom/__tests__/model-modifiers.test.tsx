/**
 * Model directive modifiers (trim / number / lazy / debounce) and named
 * model bindings on native elements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, patchProp } from '../src/index';
import { component, jsx, signal } from 'sigx';

describe('model modifiers', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('trim strips surrounding whitespace before write-back', () => {
        const state = signal({ name: '' });
        const App = component(() => () => (
            <input type="text" model={() => state.name} modelModifiers={{ trim: true }} />
        ));
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = '  hello  ';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.name).toBe('hello');
    });

    it('number coerces the value to a number', () => {
        const state = signal({ age: 0 as number | string });
        // Call form: a text input's `model` is typed to return string, but the
        // `number` modifier intentionally writes back a number.
        const App = component(() => () =>
            jsx('input', { type: 'text', model: () => state.age, modelModifiers: { number: true } })
        );
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = '42';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.age).toBe(42);
        expect(typeof state.age).toBe('number');
    });

    it('number leaves non-numeric input untouched', () => {
        const state = signal({ age: '' as number | string });
        const App = component(() => () =>
            jsx('input', { type: 'text', model: () => state.age, modelModifiers: { number: true } })
        );
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'abc';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.age).toBe('abc');
    });

    it('lazy syncs on change, not on input', () => {
        const state = signal({ name: '' });
        const App = component(() => () => (
            <input type="text" model={() => state.name} modelModifiers={{ lazy: true }} />
        ));
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'typing';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.name).toBe(''); // input event ignored when lazy

        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(state.name).toBe('typing');
    });

    it('debounce cancels a pending write when the handler is replaced', () => {
        vi.useFakeTimers();
        try {
            const input = document.createElement('input');
            input.type = 'text';
            container.appendChild(input);

            const writes: string[] = [];
            const makeHandler = () => {
                const fn = (v: string) => { writes.push(v); };
                (fn as any).__sigx_modelModifiers = { debounce: 200 };
                return fn;
            };

            // Attach a debounced model handler and schedule a write.
            const first = makeHandler();
            patchProp(input, 'onUpdate:modelValue', undefined, first);
            input.value = 'stale';
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // Replace the handler (simulates a re-render) before the timer fires.
            const second = makeHandler();
            patchProp(input, 'onUpdate:modelValue', first, second);

            vi.advanceTimersByTime(200);
            // The pending write from the replaced handler must not fire.
            expect(writes).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('debounce delays write-back by the configured time', () => {
        vi.useFakeTimers();
        try {
            const state = signal({ name: '' });
            const App = component(() => () => (
                <input type="text" model={() => state.name} modelModifiers={{ debounce: 200 }} />
            ));
            render(jsx(App, {}), container);

            const input = container.querySelector('input') as HTMLInputElement;
            input.value = 'a';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.value = 'ab';
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // Not yet flushed
            expect(state.name).toBe('');

            vi.advanceTimersByTime(200);
            // Only the last value lands (trailing edge)
            expect(state.name).toBe('ab');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('named model on native elements', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('named model on a native checkbox binds via the platform processor', () => {
        const state = signal({ agreed: false });
        // Use the call form to avoid relying on colon-attribute JSX compilation.
        const App = component(
            () => () => jsx('input', { type: 'checkbox', 'model:checked': () => state.agreed })
        );
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.checked).toBe(false);

        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(state.agreed).toBe(true);
    });
});
