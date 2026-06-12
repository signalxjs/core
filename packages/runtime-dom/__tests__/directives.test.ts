/**
 * DOM directive lifecycle tests
 *
 * Tests that use:* directives go through the correct lifecycle:
 * created → mounted → updated → unmounted
 *
 * Uses the real DOM renderer (runtime-dom) with happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, jsx, defineDirective, defineApp, signal } from 'sigx';

describe('DOM directive lifecycle', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        // Unmount by rendering null
        render(null as any, container);
        container.remove();
    });

    it('should call created and mounted hooks on initial render', () => {
        const created = vi.fn();
        const mounted = vi.fn();

        const dir = defineDirective<string, HTMLElement>({
            created,
            mounted
        });

        render(jsx('div', { 'use:test': [dir, 'hello'] }), container);

        expect(created).toHaveBeenCalledTimes(1);
        expect(created).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'hello' })
        );

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(mounted).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'hello' })
        );
    });

    it('should call created before mounted', () => {
        const order: string[] = [];

        const dir = defineDirective<void, HTMLElement>({
            created() { order.push('created'); },
            mounted() { order.push('mounted'); }
        });

        render(jsx('div', { 'use:test': dir }), container);

        expect(order).toEqual(['created', 'mounted']);
    });

    it('should call created on the element before it is in the DOM', () => {
        let wasInDOM = false;

        const dir = defineDirective<void, HTMLElement>({
            created(el) {
                wasInDOM = document.body.contains(el);
            }
        });

        render(jsx('div', { 'use:test': dir }), container);

        // created is called during patchProp, which happens before insert
        expect(wasInDOM).toBe(false);
    });

    it('should call mounted on the element after it is in the DOM', () => {
        let wasInDOM = false;

        const dir = defineDirective<void, HTMLElement>({
            mounted(el) {
                wasInDOM = document.body.contains(el);
            }
        });

        render(jsx('div', { 'use:test': dir }), container);

        expect(wasInDOM).toBe(true);
    });

    it('should call updated when binding value changes via re-render', () => {
        const updated = vi.fn();

        const dir = defineDirective<number, HTMLElement>({
            updated
        });

        render(jsx('div', { 'use:test': [dir, 1] }), container);
        expect(updated).not.toHaveBeenCalled();

        // Re-render with new value
        render(jsx('div', { 'use:test': [dir, 2] }), container);

        expect(updated).toHaveBeenCalledTimes(1);
        expect(updated).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 2, oldValue: 1 })
        );
    });

    it('should not call updated when value is the same', () => {
        const updated = vi.fn();

        const dir = defineDirective<number, HTMLElement>({
            updated
        });

        render(jsx('div', { 'use:test': [dir, 1] }), container);
        render(jsx('div', { 'use:test': [dir, 1] }), container);

        expect(updated).not.toHaveBeenCalled();
    });

    it('should call unmounted when element is removed', () => {
        const unmounted = vi.fn();

        const dir = defineDirective<string, HTMLElement>({
            unmounted
        });

        render(jsx('div', { 'use:test': [dir, 'bye'] }), container);
        expect(unmounted).not.toHaveBeenCalled();

        // Replace with a different element type to trigger unmount
        render(jsx('span', { children: 'replaced' }), container);

        expect(unmounted).toHaveBeenCalledTimes(1);
        expect(unmounted).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'bye' })
        );
    });

    it('should call full lifecycle in order', () => {
        const order: string[] = [];

        const dir = defineDirective<number, HTMLElement>({
            created() { order.push('created'); },
            mounted() { order.push('mounted'); },
            updated() { order.push('updated'); },
            unmounted() { order.push('unmounted'); }
        });

        render(jsx('div', { 'use:test': [dir, 1] }), container);
        render(jsx('div', { 'use:test': [dir, 2] }), container);
        render(jsx('span', {}), container); // triggers unmount of div

        expect(order).toEqual(['created', 'mounted', 'updated', 'unmounted']);
    });

    it('should support directive without binding value', () => {
        const mounted = vi.fn();

        const dir = defineDirective<void, HTMLElement>({
            mounted
        });

        render(jsx('div', { 'use:auto': dir }), container);

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(mounted).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: undefined })
        );
    });

    it('should support multiple directives on one element', () => {
        const mountedA = vi.fn();
        const mountedB = vi.fn();

        const dirA = defineDirective<string, HTMLElement>({ mounted: mountedA });
        const dirB = defineDirective<number, HTMLElement>({ mounted: mountedB });

        render(jsx('div', {
            'use:alpha': [dirA, 'a'],
            'use:beta': [dirB, 42]
        }), container);

        expect(mountedA).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'a' })
        );
        expect(mountedB).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 42 })
        );
    });

    it('should pass the same element instance to all hooks', () => {
        let createdEl: HTMLElement | null = null;
        let mountedEl: HTMLElement | null = null;
        let updatedEl: HTMLElement | null = null;
        let unmountedEl: HTMLElement | null = null;

        const dir = defineDirective<number, HTMLElement>({
            created(el) { createdEl = el; },
            mounted(el) { mountedEl = el; },
            updated(el) { updatedEl = el; },
            unmounted(el) { unmountedEl = el; }
        });

        render(jsx('div', { 'use:test': [dir, 1] }), container);
        render(jsx('div', { 'use:test': [dir, 2] }), container);
        render(jsx('span', {}), container);

        expect(createdEl).not.toBeNull();
        expect(createdEl).toBe(mountedEl);
        expect(createdEl).toBe(updatedEl);
        expect(createdEl).toBe(unmountedEl);
    });

    it('should not pass use:* props to DOM attributes', () => {
        const dir = defineDirective<string, HTMLElement>({
            mounted() {}
        });

        render(jsx('div', { 'use:test': [dir, 'hello'], id: 'myid' }), container);

        const el = container.querySelector('#myid')!;
        expect(el).not.toBeNull();
        expect(el.hasAttribute('use:test')).toBe(false);
    });

    it('should work with directives inside components', () => {
        const mounted = vi.fn();

        const dir = defineDirective<string, HTMLElement>({
            mounted
        });

        const MyComponent = component(() => {
            return () => jsx('div', { 'use:tip': [dir, 'tooltip text'] });
        });

        render(jsx(MyComponent, {}), container);

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(mounted).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'tooltip text' })
        );
    });
});

describe('Custom directive registration via app.directive()', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should resolve a custom directive registered via app.directive()', () => {
        const mounted = vi.fn();

        const highlight = defineDirective<string, HTMLElement>({
            mounted(el, { value }) {
                el.style.backgroundColor = value;
                mounted(el, { value });
            }
        });

        const app = defineApp(jsx('div', { 'use:highlight': 'yellow' }));
        app.directive('highlight', highlight);
        app.mount(container);

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(mounted).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'yellow' })
        );
        expect(container.querySelector('div')!.style.backgroundColor).toBe('yellow');
    });

    it('should call full lifecycle for app-registered custom directive', () => {
        const order: string[] = [];

        const dir = defineDirective<number, HTMLElement>({
            created() { order.push('created'); },
            mounted() { order.push('mounted'); },
            updated() { order.push('updated'); },
            unmounted() { order.push('unmounted'); }
        });

        const app = defineApp(jsx('div', { 'use:custom': 1 }));
        app.directive('custom', dir);
        app.mount(container);

        expect(order).toEqual(['created', 'mounted']);

        // Update: re-render with a new value
        render(jsx('div', { 'use:custom': 2 }), container, (app as any)._context);

        expect(order).toEqual(['created', 'mounted', 'updated']);

        // Unmount
        render(jsx('span', {}), container, (app as any)._context);

        expect(order).toEqual(['created', 'mounted', 'updated', 'unmounted']);
    });

    it('should prioritize explicit tuple over app-registered directive', () => {
        const registeredMounted = vi.fn();
        const explicitMounted = vi.fn();

        const registeredDir = defineDirective<string, HTMLElement>({ mounted: registeredMounted });
        const explicitDir = defineDirective<string, HTMLElement>({ mounted: explicitMounted });

        const app = defineApp(jsx('div', { 'use:test': [explicitDir, 'explicit'] }));
        app.directive('test', registeredDir);
        app.mount(container);

        expect(explicitMounted).toHaveBeenCalledTimes(1);
        expect(registeredMounted).not.toHaveBeenCalled();
    });

    it('should prioritize built-in directive over app-registered directive of same name', () => {
        // Register a custom directive named 'show' — built-in should win
        const customMounted = vi.fn();
        const customDir = defineDirective<boolean, HTMLElement>({ mounted: customMounted });

        const app = defineApp(jsx('div', { 'use:show': false }));
        app.directive('show', customDir);
        app.mount(container);

        // The built-in show should apply display:none, not the custom one
        const el = container.querySelector('div')!;
        expect(el.style.display).toBe('none');
        expect(customMounted).not.toHaveBeenCalled();
    });

    it('should resolve custom directive inside a component', () => {
        const mounted = vi.fn();

        const tooltip = defineDirective<string, HTMLElement>({
            mounted(el, { value }) {
                el.title = value;
                mounted(el, { value });
            }
        });

        const MyComponent = component(() => {
            return () => jsx('div', { 'use:tooltip': 'hover text' });
        });

        const app = defineApp(jsx(MyComponent, {}));
        app.directive('tooltip', tooltip);
        app.mount(container);

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(container.querySelector('div')!.title).toBe('hover text');
    });

    it('should warn in dev mode when directive is not found', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Render with a use:unknown directive that is not registered
        render(jsx('div', { 'use:unknown': 'value' }), container);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('use:unknown')
        );

        warnSpy.mockRestore();
    });

    it('should warn when app.directive() receives a non-directive object', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const app = defineApp(jsx('div', {}));
        app.directive('bad', { mounted() {} }); // Plain object, not via defineDirective

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('defineDirective')
        );

        warnSpy.mockRestore();
    });

    it('should support multiple custom directives on one element', () => {
        const mountedA = vi.fn();
        const mountedB = vi.fn();

        const dirA = defineDirective<string, HTMLElement>({ mounted: mountedA });
        const dirB = defineDirective<number, HTMLElement>({ mounted: mountedB });

        const app = defineApp(jsx('div', { 'use:alpha': 'a', 'use:beta': 42 }));
        app.directive('alpha', dirA);
        app.directive('beta', dirB);
        app.mount(container);

        expect(mountedA).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 'a' })
        );
        expect(mountedB).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ value: 42 })
        );
    });
});
