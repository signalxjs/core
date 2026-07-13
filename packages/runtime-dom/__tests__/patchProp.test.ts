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
import { render, patchProp } from '../src/index';
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

    describe('className handling — nullish/false removal (#98)', () => {
        it('removes the class attribute when className is nullish, not class="undefined"', () => {
            const el = document.createElement('div');
            patchProp(el, 'className', null, undefined);
            expect(el.hasAttribute('class')).toBe(false);
            patchProp(el, 'className', null, null);
            expect(el.hasAttribute('class')).toBe(false);
        });

        it('removes a previously set class when className becomes nullish or false', () => {
            const el = document.createElement('div');
            patchProp(el, 'className', null, 'foo');
            expect(el.getAttribute('class')).toBe('foo');
            patchProp(el, 'className', 'foo', false);
            expect(el.hasAttribute('class')).toBe(false);
        });

        it('renders a pass-through undefined className with no class attribute', () => {
            const props: any = {};
            const App = component(() => {
                return () => jsx('div', { className: props.className });
            });
            render(jsx(App, {}), container);

            const div = container.firstElementChild as HTMLDivElement;
            expect(div.hasAttribute('class')).toBe(false);
        });
    });

    describe('event handler error routing (app onError)', () => {
        /** Minimal AppContext accepted by handleComponentError. */
        function makeAppContext(onError?: (err: Error, instance: unknown, info: string) => boolean | void) {
            return {
                app: null,
                provides: new Map(),
                disposables: new Set(),
                config: onError ? { onError } : {},
                hooks: [],
                directives: new Map(),
            } as any;
        }

        it('suppresses the throw when config.onError returns true and passes (Error, null, "event handler")', () => {
            const onError = vi.fn().mockReturnValue(true);
            const el = document.createElement('button');
            const handler = () => { throw new Error('boom'); };
            patchProp(el, 'onClick', null, handler, undefined, makeAppContext(onError));

            expect(() => el.dispatchEvent(new MouseEvent('click'))).not.toThrow();
            expect(onError).toHaveBeenCalledTimes(1);
            const [err, instance, info] = onError.mock.calls[0];
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toBe('boom');
            expect(instance).toBeNull();
            expect(info).toBe('event handler');
        });

        it('rethrows synchronously when no appContext was passed', () => {
            const el = document.createElement('button');
            const boom = new Error('unrouted');
            patchProp(el, 'onClick', null, () => { throw boom; });

            let caught: unknown = null;
            try {
                el.dispatchEvent(new MouseEvent('click'));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBe(boom);
        });

        it('rethrows synchronously when config.onError returns false', () => {
            const onError = vi.fn().mockReturnValue(false);
            const el = document.createElement('button');
            const boom = new Error('declined');
            patchProp(el, 'onClick', null, () => { throw boom; }, undefined, makeAppContext(onError));

            let caught: unknown = null;
            try {
                el.dispatchEvent(new MouseEvent('click'));
            } catch (e) {
                caught = e;
            }
            expect(onError).toHaveBeenCalledTimes(1);
            expect(caught).toBe(boom);
        });

        it('normalizes a non-Error throw to Error for the handler', () => {
            const onError = vi.fn().mockReturnValue(true);
            const el = document.createElement('button');
            patchProp(el, 'onClick', null, () => { throw 'boom-string'; }, undefined, makeAppContext(onError));

            expect(() => el.dispatchEvent(new MouseEvent('click'))).not.toThrow();
            const [err] = onError.mock.calls[0];
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toBe('boom-string');
        });

        it('rethrows the ORIGINAL non-Error value when unhandled', () => {
            const onError = vi.fn().mockReturnValue(false);
            const el = document.createElement('button');
            patchProp(el, 'onClick', null, () => { throw 'raw-value'; }, undefined, makeAppContext(onError));

            let caught: unknown = null;
            try {
                el.dispatchEvent(new MouseEvent('click'));
            } catch (e) {
                caught = e;
            }
            // The handler saw an Error, but the rethrow preserves the original
            expect(caught).toBe('raw-value');
        });

        it('re-patching the same event key swaps both the handler and its appContext', () => {
            const onErrorA = vi.fn().mockReturnValue(true);
            const onErrorB = vi.fn().mockReturnValue(true);
            const el = document.createElement('button');

            const handlerA = vi.fn(() => { throw new Error('from-A'); });
            patchProp(el, 'onClick', null, handlerA, undefined, makeAppContext(onErrorA));
            el.dispatchEvent(new MouseEvent('click'));
            expect(handlerA).toHaveBeenCalledTimes(1);
            expect(onErrorA).toHaveBeenCalledTimes(1);

            const handlerB = vi.fn(() => { throw new Error('from-B'); });
            patchProp(el, 'onClick', null, handlerB, undefined, makeAppContext(onErrorB));
            el.dispatchEvent(new MouseEvent('click'));

            // Old handler and old context untouched; new pair took over
            expect(handlerA).toHaveBeenCalledTimes(1);
            expect(onErrorA).toHaveBeenCalledTimes(1);
            expect(handlerB).toHaveBeenCalledTimes(1);
            expect(onErrorB).toHaveBeenCalledTimes(1);
            expect((onErrorB.mock.calls[0][0] as Error).message).toBe('from-B');
        });

        it('routes model write-back (onUpdate:modelValue) throws identically', () => {
            const onError = vi.fn().mockReturnValue(true);
            const el = document.createElement('input');
            document.body.appendChild(el);
            const writeBack = (_v: unknown) => { throw new Error('model-boom'); };
            patchProp(el, 'onUpdate:modelValue', null, writeBack, undefined, makeAppContext(onError));

            el.value = 'typed';
            expect(() => el.dispatchEvent(new Event('input'))).not.toThrow();
            expect(onError).toHaveBeenCalledTimes(1);
            const [err, instance, info] = onError.mock.calls[0];
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toBe('model-boom');
            expect(instance).toBeNull();
            expect(info).toBe('event handler');
            el.remove();
        });

        it('model write-back throw escapes when onError is absent', () => {
            const el = document.createElement('input');
            document.body.appendChild(el);
            const boom = new Error('model-unrouted');
            patchProp(el, 'onUpdate:modelValue', null, () => { throw boom; });

            let caught: unknown = null;
            el.value = 'typed';
            try {
                el.dispatchEvent(new Event('input'));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBe(boom);
            el.remove();
        });
    });

    describe('direct patchProp edge cases', () => {
        it('ignores a null element', () => {
            expect(() => patchProp(null as any, 'class', null, 'x')).not.toThrow();
        });

        it('unwraps CustomEvent detail for on* handlers', () => {
            const el = document.createElement('div');
            const handler = vi.fn();
            patchProp(el, 'onThing', null, handler);

            el.dispatchEvent(new CustomEvent('thing', { detail: { ok: 1 } }));
            expect(handler).toHaveBeenCalledWith({ ok: 1 });

            // swapped handler receives the detail through the same invoker
            const next = vi.fn();
            patchProp(el, 'onThing', handler, next);
            el.dispatchEvent(new CustomEvent('thing', { detail: 2 }));
            expect(next).toHaveBeenCalledWith(2);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('removes the listener when the handler becomes null', () => {
            const el = document.createElement('button');
            const handler = vi.fn();
            patchProp(el, 'onClick', null, handler);

            el.dispatchEvent(new MouseEvent('click'));
            expect(handler).toHaveBeenCalledTimes(1);

            patchProp(el, 'onClick', handler, null);
            el.dispatchEvent(new MouseEvent('click'));
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });
});
