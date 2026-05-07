/**
 * patchProp tests — DOM property vs attribute handling
 *
 * Validates that patchProp correctly routes props through the
 * attribute / property decision tree, including the `prop:` prefix
 * for forcing direct DOM property assignment.
 *
 * Uses the real DOM renderer (runtime-dom) with happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, jsx, signal } from 'sigx';

describe('patchProp', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    describe('prop: prefix — direct DOM property assignment', () => {
        it('should set prop:innerHTML as a DOM property', () => {
            const App = component(() => {
                return () => jsx('div', { 'prop:innerHTML': '<b>hello</b>' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.innerHTML).toBe('<b>hello</b>');
        });

        it('should set prop:textContent as a DOM property', () => {
            const App = component(() => {
                return () => jsx('div', { 'prop:textContent': 'plain text' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.textContent).toBe('plain text');
        });

        it('should set prop:value as a DOM property on input', () => {
            const App = component(() => {
                return () => jsx('input', { 'prop:value': 'forced' });
            });
            render(jsx(App, {}), container);

            const input = container.firstElementChild as HTMLInputElement;
            expect(input.value).toBe('forced');
        });

        it('should reactively update prop:innerHTML when signal changes', () => {
            const state = signal({ html: '<em>first</em>' });
            const App = component(() => {
                return () => jsx('div', { 'prop:innerHTML': state.html });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.innerHTML).toBe('<em>first</em>');

            state.html = '<strong>second</strong>';
            expect(div.innerHTML).toBe('<strong>second</strong>');
        });
    });

    describe('dot prefix (.prop) — direct DOM property assignment', () => {
        it('should set .innerHTML as a DOM property', () => {
            const App = component(() => {
                return () => jsx('div', { '.innerHTML': '<b>dot</b>' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.innerHTML).toBe('<b>dot</b>');
        });

        it('should set .textContent as a DOM property', () => {
            const App = component(() => {
                return () => jsx('div', { '.textContent': 'dot text' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.textContent).toBe('dot text');
        });
    });

    describe('key in dom heuristic — automatic property routing', () => {
        it('should set known DOM properties as properties (not attributes)', () => {
            const App = component(() => {
                return () => jsx('div', { hidden: true });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.hidden).toBe(true);
        });

        it('should remove attribute when value is null', () => {
            const state = signal({ title: 'hello' as string | null });
            const App = component(() => {
                return () => jsx('div', { title: state.title });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.getAttribute('title')).toBe('hello');

            state.title = null;
            expect(div.hasAttribute('title')).toBe(false);
        });
    });

    describe('form elements — value/checked as DOM properties', () => {
        it('should set input value as a DOM property', () => {
            const App = component(() => {
                return () => jsx('input', { type: 'text', value: 'test-val' });
            });
            render(jsx(App, {}), container);

            const input = container.firstElementChild as HTMLInputElement;
            expect(input.value).toBe('test-val');
        });

        it('should set checkbox checked as a DOM property', () => {
            const App = component(() => {
                return () => jsx('input', { type: 'checkbox', checked: true });
            });
            render(jsx(App, {}), container);

            const input = container.firstElementChild as HTMLInputElement;
            expect(input.checked).toBe(true);
        });
    });

    describe('unknown keys — setAttribute fallback', () => {
        it('should use setAttribute for data- attributes', () => {
            const App = component(() => {
                return () => jsx('div', { 'data-testid': 'my-id' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.getAttribute('data-testid')).toBe('my-id');
        });

        it('should remove attribute when set to false', () => {
            const state = signal({ show: true as boolean });
            const App = component(() => {
                return () => jsx('div', { 'data-visible': state.show });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.hasAttribute('data-visible')).toBe(true);

            state.show = false;
            expect(div.hasAttribute('data-visible')).toBe(false);
        });
    });

    describe('SVG elements — setAttribute by default', () => {
        it('should use setAttribute for SVG attributes (preserving case)', () => {
            const App = component(() => {
                return () => jsx('svg', {
                    viewBox: '0 0 100 100',
                    children: jsx('rect', { x: '10', y: '10', width: '80', height: '80' })
                });
            });
            render(jsx(App, {}), container);

            const svg = container.firstElementChild as SVGSVGElement;
            expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
        });

        it('should set prop:innerHTML as a property on SVG elements', () => {
            const App = component(() => {
                return () => jsx('svg', { 'prop:innerHTML': '<circle cx="50" cy="50" r="40" />' });
            });
            render(jsx(App, {}), container);

            const svg = container.firstElementChild as SVGSVGElement;
            expect(svg.querySelector('circle')).toBeTruthy();
        });
    });

    describe('style handling — undefined/null removal', () => {
        it('should remove a regular style property when set to undefined', () => {
            const state = signal({ style: { color: 'red', fontSize: '14px' } as Record<string, any> });
            const App = component(() => {
                return () => jsx('div', { style: state.style });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.color).toBe('red');
            expect(div.style.fontSize).toBe('14px');

            // Setting fontSize to undefined should remove it
            state.style = { color: 'red', fontSize: undefined };
            expect(div.style.color).toBe('red');
            expect(div.style.fontSize).toBe('');
        });

        it('should remove a regular style property when set to null', () => {
            const state = signal({ style: { color: 'red', fontSize: '14px' } as Record<string, any> });
            const App = component(() => {
                return () => jsx('div', { style: state.style });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.fontSize).toBe('14px');

            state.style = { color: 'red', fontSize: null };
            expect(div.style.color).toBe('red');
            expect(div.style.fontSize).toBe('');
        });

        it('should not set CSS custom property to the string "undefined"', () => {
            const state = signal({ style: { '--my-color': 'blue' } as Record<string, any> });
            const App = component(() => {
                return () => jsx('div', { style: state.style });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.getPropertyValue('--my-color')).toBe('blue');

            state.style = { '--my-color': undefined };
            // Should be removed, not set to the literal string "undefined"
            expect(div.style.getPropertyValue('--my-color')).not.toBe('undefined');
            expect(div.style.getPropertyValue('--my-color')).toBe('');
        });

        it('should remove old style properties not present in the new style object', () => {
            const state = signal({ style: { color: 'red', fontSize: '14px' } as Record<string, any> });
            const App = component(() => {
                return () => jsx('div', { style: state.style });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.color).toBe('red');
            expect(div.style.fontSize).toBe('14px');

            // New style object omits fontSize entirely — it should be removed
            state.style = { color: 'green' };
            expect(div.style.color).toBe('green');
            expect(div.style.fontSize).toBe('');
        });

        it('should still set normal style values correctly', () => {
            const App = component(() => {
                return () => jsx('div', { style: { backgroundColor: 'yellow', padding: '10px' } });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.backgroundColor).toBe('yellow');
            expect(div.style.padding).toBe('10px');
        });

        it('should handle string style values', () => {
            const App = component(() => {
                return () => jsx('div', { style: 'color: red; font-size: 14px' });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.style.color).toBe('red');
            expect(div.style.fontSize).toBe('14px');
        });
    });
});
