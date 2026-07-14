/**
 * Model directive modifiers (trim / number / lazy / debounce) and named
 * model bindings on native elements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, patchProp } from '../src/index';
import { component, jsx, signal, registerModelProcessor } from 'sigx';
import type { VNode } from 'sigx';

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

describe('modifier coverage across binding paths', () => {
    // The write-back wrapper lives in runtime-core on `onUpdate:modelValue`, so it
    // applies regardless of which path produced the handler. These exercise the
    // paths the DOM-only implementation missed.

    it('applies value-transforms on a named model (model:name)', () => {
        const state = signal({ title: '' });
        const vnode = jsx('input', {
            'model:value': () => state.title,
            modelModifiers: { trim: true },
        }) as VNode;
        // Named binding writes back via onUpdate:<name>.
        const handler = vnode.props['onUpdate:value'] as (v: any) => void;
        expect(handler).toBeTypeOf('function');
        handler('  spaced  ');
        expect(state.title).toBe('spaced');
    });

    it('applies value-transforms through a custom registerModelProcessor element', () => {
        const state = signal({ val: '' });
        // Custom processor only matches its own element type, so leaving it
        // registered for the rest of the file is harmless.
        registerModelProcessor((type, props, [obj, key]) => {
            if (type !== 'my-input') return false;
            props.value = (obj as any)[key];
            props['onUpdate:modelValue'] = (v: any) => { (obj as any)[key] = v; };
            return true;
        });
        const vnode = jsx('my-input', {
            model: () => state.val,
            modelModifiers: { trim: true, number: true },
        }) as VNode;
        const handler = vnode.props['onUpdate:modelValue'] as (v: any) => void;
        expect(handler).toBeTypeOf('function');
        handler('  42  ');
        // trim → number applied on top of the custom processor's write.
        expect(state.val).toBe(42);
    });
});

describe('per-element modifier typing (compile-time)', () => {
    it('scopes trim/number off checkbox/radio but allows timing modifiers', () => {
        const state = signal({ name: '', agreed: false });

        // Value transforms are valid on a text input.
        <input type="text" model={() => state.name} modelModifiers={{ trim: true, number: true }} />;

        // @ts-expect-error trim is not a valid modifier on a checkbox (no-op on boolean)
        <input type="checkbox" model={() => state.agreed} modelModifiers={{ trim: true }} />;

        // Timing modifiers remain valid on a checkbox.
        <input type="checkbox" model={() => state.agreed} modelModifiers={{ debounce: 200 }} />;
        <input type="checkbox" model={() => state.agreed} modelModifiers={{ lazy: true }} />;

        expect(true).toBe(true);
    });
});

describe('dev no-op modifier warning', () => {
    it('warns when a value transform is used on a checkbox', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const state = signal({ agreed: false });
            jsx('input', {
                type: 'checkbox',
                model: () => state.agreed,
                // trim is a no-op on a boolean checkbox value.
                modelModifiers: { trim: true } as any,
            });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('no-ops');
        } finally {
            warn.mockRestore();
        }
    });

    it('warns when trim is bound to a non-string state value', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const state = signal({ count: 5 as number });
            jsx('input', { type: 'text', model: () => state.count, modelModifiers: { trim: true } as any });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('string input values');
        } finally {
            warn.mockRestore();
        }
    });

    it('does not warn for trim on an initially-empty string field', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const state = signal({ name: '' });
            jsx('input', { type: 'text', model: () => state.name, modelModifiers: { trim: true } });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

