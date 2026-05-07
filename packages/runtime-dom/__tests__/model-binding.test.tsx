/**
 * Model binding integration tests — DOM-level two-way binding
 *
 * Tests that model binding correctly responds to programmatic input events
 * (simulating how Playwright/testing tools interact with inputs).
 * Also tests model binding through hydration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, signal, Fragment, Text } from 'sigx';
import type { Define } from 'sigx';

function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('model binding — native input', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should set initial value from signal', () => {
        const state = signal({ name: 'hello' });
        const App = component(() => {
            return () => <input type="text" model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('hello');
    });

    it('should update signal when input event is dispatched', async () => {
        const state = signal({ name: '' });
        const App = component(() => {
            return () => <input type="text" model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'typed';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.name).toBe('typed');
    });

    it('should update DOM when signal changes programmatically', async () => {
        const state = signal({ name: 'initial' });
        const App = component(() => {
            return () => <input type="text" model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('initial');

        state.name = 'updated';
        await nextTick();
        expect(input.value).toBe('updated');
    });

    it('should handle checkbox model binding via change event', () => {
        const state = signal({ agreed: false });
        const App = component(() => {
            return () => <input type="checkbox" model={() => state.agreed} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.checked).toBe(false);

        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(state.agreed).toBe(true);
    });

    it('should handle number input model binding', () => {
        const state = signal({ count: 0 });
        const App = component(() => {
            return () => <input type="number" model={() => state.count} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.valueAsNumber = 42;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.count).toBe(42);
    });

    it('should handle select model binding via change event', () => {
        const state = signal({ color: 'red' });
        const App = component(() => {
            return () => (
                <select model={() => state.color}>
                    <option value="red">Red</option>
                    <option value="blue">Blue</option>
                </select>
            );
        });
        render(jsx(App, {}), container);

        const select = container.querySelector('select') as HTMLSelectElement;
        select.value = 'blue';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(state.color).toBe('blue');
    });

    it('should handle textarea model binding', () => {
        const state = signal({ bio: '' });
        const App = component(() => {
            return () => <textarea model={() => state.bio} />;
        });
        render(jsx(App, {}), container);

        const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
        textarea.value = 'Hello world';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.bio).toBe('Hello world');
    });

    it('should handle multi-select model binding — initial selection', async () => {
        const state = signal({ items: ['A', 'B'] as string[] });
        const App = component(() => {
            return () => (
                <select multiple model={() => state.items}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                </select>
            );
        });
        render(jsx(App, {}), container);
        await nextTick();

        const select = container.querySelector('select') as HTMLSelectElement;
        const options = select.options;
        expect(options[0].selected).toBe(true);   // A
        expect(options[1].selected).toBe(true);   // B
        expect(options[2].selected).toBe(false);  // C
    });

    it('should handle multi-select model binding — change event updates signal', async () => {
        const state = signal({ items: ['A'] as string[] });
        const App = component(() => {
            return () => (
                <select multiple model={() => state.items}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                </select>
            );
        });
        render(jsx(App, {}), container);
        await nextTick();

        const select = container.querySelector('select') as HTMLSelectElement;
        // Simulate selecting A and B
        select.options[0].selected = true;
        select.options[1].selected = true;
        select.options[2].selected = false;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        expect(state.items).toEqual(['A', 'B']);
    });

    it('should preserve multi-select selection after re-render', async () => {
        const state = signal({ items: ['A'] as string[], label: 'pick' });
        const App = component(() => {
            return () => (
                <div>
                    <span>{state.label}</span>
                    <select multiple model={() => state.items}>
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                    </select>
                </div>
            );
        });
        render(jsx(App, {}), container);
        await nextTick();

        const select = container.querySelector('select') as HTMLSelectElement;

        // Simulate selecting A and B via change event
        select.options[0].selected = true;
        select.options[1].selected = true;
        select.options[2].selected = false;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(state.items).toEqual(['A', 'B']);

        // Trigger an unrelated re-render
        state.label = 'updated';
        await nextTick();

        // After re-render, A and B should still be selected
        expect(select.options[0].selected).toBe(true);   // A
        expect(select.options[1].selected).toBe(true);   // B
        expect(select.options[2].selected).toBe(false);   // C
    });
});

describe('model binding — component wrapping native input', () => {
    let container: HTMLElement;

    // Minimal Input component mirroring DaisyUI's pattern
    const InputComponent = component<Define.Model<string> & Define.Prop<'placeholder', string>>(({ props, emit }) => {
        return () => (
            <input
                type="text"
                class="input"
                value={props.model?.value != null ? String(props.model.value) : ''}
                placeholder={props.placeholder}
                onInput={(e) => {
                    const value = (e.target as HTMLInputElement).value;
                    if (props.model) {
                        props.model.value = value;
                    }
                }}
            />
        );
    }, { name: 'InputComponent' });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should set initial value from signal through component model', () => {
        const state = signal({ name: 'hello' });
        const App = component(() => {
            return () => <InputComponent model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('hello');
    });

    it('should update signal when input event fires on wrapped input', async () => {
        const state = signal({ name: '' });
        const App = component(() => {
            return () => <InputComponent model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'typed';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.name).toBe('typed');
    });

    it('should update DOM when signal changes programmatically', async () => {
        const state = signal({ name: 'initial' });
        const App = component(() => {
            return () => <InputComponent model={() => state.name} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('initial');

        state.name = 'updated';
        await nextTick();
        expect(input.value).toBe('updated');
    });
});

describe('model binding — nested state paths', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should bind to nested state property (state.form.field)', () => {
        const state = signal({
            form: { displayName: 'Administrator', password: '' }
        });
        const App = component(() => {
            return () => <input type="text" model={() => state.form.displayName} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('Administrator');
    });

    it('should update nested state on input event', () => {
        const state = signal({
            form: { displayName: '', password: '' }
        });
        const App = component(() => {
            return () => <input type="text" model={() => state.form.displayName} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'New Name';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.form.displayName).toBe('New Name');
        // Must NOT replace the entire form object
        expect(state.form.password).toBe('');
    });

    it('should not cross-contaminate fields in nested state', async () => {
        const state = signal({
            form: { displayName: 'Admin', password: '' }
        });
        const App = component(() => {
            return () => (
                <>
                    <input type="text" model={() => state.form.displayName} />
                    <input type="password" model={() => state.form.password} />
                </>
            );
        });
        render(jsx(App, {}), container);

        const [nameInput, passInput] = container.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
        expect(nameInput.value).toBe('Admin');
        expect(passInput.value).toBe('');

        // Typing in password should NOT affect displayName
        passInput.value = 'secret123';
        passInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.form.password).toBe('secret123');
        expect(state.form.displayName).toBe('Admin');

        await nextTick();
        expect(nameInput.value).toBe('Admin');
    });

    it('should bind to deeply nested state (3+ levels)', () => {
        const state = signal({
            app: { settings: { theme: 'dark' } }
        });
        const App = component(() => {
            return () => <input type="text" model={() => state.app.settings.theme} />;
        });
        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('dark');

        input.value = 'light';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.app.settings.theme).toBe('light');
    });

    it('should work with component-wrapped input and nested state', () => {
        // Component that forwards model via binding (correct pattern)
        const InputComponent = component<Define.Model<string>>(({ props }) => {
            return () => {
                const modelProps = props.model
                    ? { model: [props.model.binding[0], props.model.binding[1]] as [object, string] }
                    : {};
                return <input type="text" {...modelProps} />;
            };
        });

        const state = signal({
            form: { displayName: 'Admin', password: '' }
        });
        const App = component(() => {
            return () => (
                <>
                    <InputComponent model={() => state.form.displayName} />
                    <InputComponent model={() => state.form.password} />
                </>
            );
        });
        render(jsx(App, {}), container);

        const [nameInput, passInput] = container.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
        expect(nameInput.value).toBe('Admin');
        expect(passInput.value).toBe('');

        // Typing in password must not affect displayName
        passInput.value = 'secret';
        passInput.dispatchEvent(new Event('input', { bubbles: true }));

        expect(state.form.password).toBe('secret');
        expect(state.form.displayName).toBe('Admin');
        expect(nameInput.value).toBe('Admin');
    });
});
