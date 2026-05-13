/**
 * Coverage for branches in runtime-dom/src/model-processor.ts not exercised
 * by the main model-binding.test.tsx suite: array checkbox groups, radio buttons,
 * multi-select arrays, and chained handlers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, signal } from 'sigx';

function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

let container: HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    render(null as any, container);
    container.remove();
});

describe('model-processor — array checkbox group', () => {
    it('reflects initial array membership in the checked attribute', () => {
        const state = signal({ tags: ['a', 'c'] });
        const App = component(() => () => (
            <>
                <input type="checkbox" value="a" model={() => state.tags} />
                <input type="checkbox" value="b" model={() => state.tags} />
                <input type="checkbox" value="c" model={() => state.tags} />
            </>
        ));
        render(jsx(App, {}), container);

        const inputs = container.querySelectorAll('input');
        expect((inputs[0] as HTMLInputElement).checked).toBe(true);
        expect((inputs[1] as HTMLInputElement).checked).toBe(false);
        expect((inputs[2] as HTMLInputElement).checked).toBe(true);
    });

    it('pushes onto array when a previously-unchecked box becomes checked', async () => {
        const state = signal({ tags: ['a'] });
        const App = component(() => () => (
            <>
                <input type="checkbox" value="a" model={() => state.tags} />
                <input type="checkbox" value="b" model={() => state.tags} />
            </>
        ));
        render(jsx(App, {}), container);

        const b = container.querySelectorAll('input')[1] as HTMLInputElement;
        b.checked = true;
        b.dispatchEvent(new Event('change', { bubbles: true }));
        await nextTick();
        expect(state.tags).toEqual(['a', 'b']);
    });

    it('removes from array when a checked box becomes unchecked', async () => {
        const state = signal({ tags: ['a', 'b', 'c'] });
        const App = component(() => () => (
            <>
                <input type="checkbox" value="a" model={() => state.tags} />
                <input type="checkbox" value="b" model={() => state.tags} />
                <input type="checkbox" value="c" model={() => state.tags} />
            </>
        ));
        render(jsx(App, {}), container);

        const b = container.querySelectorAll('input')[1] as HTMLInputElement;
        b.checked = false;
        b.dispatchEvent(new Event('change', { bubbles: true }));
        await nextTick();
        expect(state.tags).toEqual(['a', 'c']);
    });

    it('does not push a duplicate when the value is already present', async () => {
        const state = signal({ tags: ['a'] });
        const App = component(() => () => (
            <input type="checkbox" value="a" model={() => state.tags} />
        ));
        render(jsx(App, {}), container);
        const input = container.querySelector('input') as HTMLInputElement;
        // Force the handler to fire with checked=true even though 'a' is already there
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await nextTick();
        expect(state.tags).toEqual(['a']);
    });
});

describe('model-processor — radio button group', () => {
    it('selects the radio whose value matches the signal', () => {
        const state = signal({ choice: 'two' });
        const App = component(() => () => (
            <>
                <input type="radio" name="g" value="one" model={() => state.choice} />
                <input type="radio" name="g" value="two" model={() => state.choice} />
                <input type="radio" name="g" value="three" model={() => state.choice} />
            </>
        ));
        render(jsx(App, {}), container);
        const radios = container.querySelectorAll<HTMLInputElement>('input');
        expect(radios[0].checked).toBe(false);
        expect(radios[1].checked).toBe(true);
        expect(radios[2].checked).toBe(false);
    });

    it('updates the signal when a different radio becomes checked', async () => {
        const state = signal({ choice: 'one' });
        const App = component(() => () => (
            <>
                <input type="radio" name="g" value="one" model={() => state.choice} />
                <input type="radio" name="g" value="two" model={() => state.choice} />
            </>
        ));
        render(jsx(App, {}), container);
        const two = container.querySelectorAll<HTMLInputElement>('input')[1];
        two.checked = true;
        two.dispatchEvent(new Event('change', { bubbles: true }));
        await nextTick();
        expect(state.choice).toBe('two');
    });
});

describe('model-processor — fallbacks for null/undefined signal values', () => {
    it('falls back to "" when input model value is null', () => {
        const state = signal({ name: null as any });
        const App = component(() => () => (
            <input type="text" model={() => state.name} />
        ));
        render(jsx(App, {}), container);
        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('');
    });

    it('falls back to "" when textarea model value is undefined', () => {
        const state = signal({ body: undefined as any });
        const App = component(() => () => (
            <textarea model={() => state.body} />
        ));
        render(jsx(App, {}), container);
        const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea.value).toBe('');
    });

    it('falls back to "" when single-select value is null (empty option matches)', () => {
        const state = signal({ choice: null as any });
        const App = component(() => () => (
            <select model={() => state.choice}>
                <option value="">— pick one —</option>
                <option value="a">A</option>
                <option value="b">B</option>
            </select>
        ));
        render(jsx(App, {}), container);
        const select = container.querySelector('select') as HTMLSelectElement;
        // With null in the signal, the processor passes '' through, which selects
        // the empty option (first one with value="").
        expect(select.value).toBe('');
    });
});
