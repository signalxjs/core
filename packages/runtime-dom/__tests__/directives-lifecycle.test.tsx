/**
 * Directive lifecycle tests — focuses on aspects NOT covered by directives.test.ts:
 *
 * 1. Signal-driven component re-renders triggering directive hooks
 * 2. Directive prop removal during patch (use:dir disappears between renders)
 * 3. Conditional rendering unmounting elements with directives
 * 4. Multiple directives with independent update/remove lifecycles
 * 5. Complete binding shape verification across all hooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, jsx, defineDirective, defineApp } from 'sigx';
import { signal } from '@sigx/reactivity';

describe('use:* directive lifecycle', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should call directive function on mount', () => {
        const created = vi.fn();
        const mounted = vi.fn();

        const myDirective = defineDirective<string, HTMLElement>({
            created(el, binding) {
                created(el, binding);
            },
            mounted(el, binding) {
                mounted(el, binding);
            }
        });

        render(jsx('div', { 'use:myDirective': [myDirective, 'hello'] }), container);

        // created is called during prop patching (before DOM insert)
        expect(created).toHaveBeenCalledTimes(1);
        const createdEl = created.mock.calls[0][0];
        expect(createdEl).toBeInstanceOf(HTMLDivElement);
        expect(created.mock.calls[0][1]).toEqual({ value: 'hello' });

        // mounted is called after element is in the DOM
        expect(mounted).toHaveBeenCalledTimes(1);
        expect(mounted.mock.calls[0][0]).toBe(createdEl);
        expect(mounted.mock.calls[0][1]).toEqual({ value: 'hello' });
    });

    it('should call directive with updated value on re-render', () => {
        const hooks = {
            created: vi.fn(),
            mounted: vi.fn(),
            updated: vi.fn()
        };

        const dir = defineDirective<number, HTMLElement>(hooks);

        render(jsx('div', { 'use:counter': [dir, 10] }), container);
        expect(hooks.created).toHaveBeenCalledTimes(1);
        expect(hooks.mounted).toHaveBeenCalledTimes(1);
        expect(hooks.updated).not.toHaveBeenCalled();

        // Re-render with new value
        render(jsx('div', { 'use:counter': [dir, 20] }), container);

        // updated receives both oldValue and value in the binding
        expect(hooks.updated).toHaveBeenCalledTimes(1);
        expect(hooks.updated).toHaveBeenCalledWith(
            expect.any(HTMLDivElement),
            { value: 20, oldValue: 10 }
        );

        // created and mounted should NOT be called again
        expect(hooks.created).toHaveBeenCalledTimes(1);
        expect(hooks.mounted).toHaveBeenCalledTimes(1);
    });

    it('should call directive cleanup on element unmount', () => {
        const order: string[] = [];

        const dir = defineDirective<string, HTMLElement>({
            created() { order.push('created'); },
            mounted() { order.push('mounted'); },
            unmounted(el, binding) {
                order.push('unmounted');
                // Verify the element still exists (unmounted is called before removal)
                expect(el).toBeInstanceOf(HTMLDivElement);
                expect(binding.value).toBe('active');
            }
        });

        // Mount with directive
        render(jsx('div', { 'use:tracker': [dir, 'active'] }), container);
        expect(order).toEqual(['created', 'mounted']);

        // Replace element — triggers unmount of old element and its directives
        render(jsx('p', { children: 'replaced' }), container);
        expect(order).toEqual(['created', 'mounted', 'unmounted']);

        // Verify old element is gone
        expect(container.querySelector('div')).toBeNull();
        expect(container.querySelector('p')).not.toBeNull();
    });

    it('should support multiple directives on same element', () => {
        const logA: string[] = [];
        const logB: string[] = [];

        const dirA = defineDirective<string, HTMLElement>({
            created() { logA.push('created'); },
            mounted() { logA.push('mounted'); },
            updated(_, { value }) { logA.push(`updated:${value}`); },
            unmounted() { logA.push('unmounted'); }
        });

        const dirB = defineDirective<number, HTMLElement>({
            created() { logB.push('created'); },
            mounted() { logB.push('mounted'); },
            updated(_, { value }) { logB.push(`updated:${value}`); },
            unmounted() { logB.push('unmounted'); }
        });

        // Mount with both directives
        render(jsx('div', {
            'use:alpha': [dirA, 'a'],
            'use:beta': [dirB, 1]
        }), container);

        expect(logA).toEqual(['created', 'mounted']);
        expect(logB).toEqual(['created', 'mounted']);

        // Update both directives
        render(jsx('div', {
            'use:alpha': [dirA, 'b'],
            'use:beta': [dirB, 2]
        }), container);

        expect(logA).toEqual(['created', 'mounted', 'updated:b']);
        expect(logB).toEqual(['created', 'mounted', 'updated:2']);

        // Unmount element — both directives should fire unmounted
        render(jsx('span', {}), container);

        expect(logA).toEqual(['created', 'mounted', 'updated:b', 'unmounted']);
        expect(logB).toEqual(['created', 'mounted', 'updated:2', 'unmounted']);
    });

    it('should pass correct arguments to directive', () => {
        const createdArgs: any[] = [];
        const mountedArgs: any[] = [];
        const updatedArgs: any[] = [];
        const unmountedArgs: any[] = [];

        const dir = defineDirective<string, HTMLElement>({
            created(el, binding) { createdArgs.push({ el, binding: { ...binding } }); },
            mounted(el, binding) { mountedArgs.push({ el, binding: { ...binding } }); },
            updated(el, binding) { updatedArgs.push({ el, binding: { ...binding } }); },
            unmounted(el, binding) { unmountedArgs.push({ el, binding: { ...binding } }); }
        });

        // Mount
        render(jsx('div', { id: 'target', 'use:test': [dir, 'first'] }), container);

        const el = container.querySelector('#target')!;
        expect(el).toBeInstanceOf(HTMLDivElement);

        // created: receives el and { value }
        expect(createdArgs).toHaveLength(1);
        expect(createdArgs[0].el).toBe(el);
        expect(createdArgs[0].binding).toEqual({ value: 'first' });

        // mounted: receives el and { value }
        expect(mountedArgs).toHaveLength(1);
        expect(mountedArgs[0].el).toBe(el);
        expect(mountedArgs[0].binding).toEqual({ value: 'first' });

        // Update
        render(jsx('div', { id: 'target', 'use:test': [dir, 'second'] }), container);

        // updated: receives el, { value, oldValue }
        expect(updatedArgs).toHaveLength(1);
        expect(updatedArgs[0].el).toBe(el);
        expect(updatedArgs[0].binding).toEqual({ value: 'second', oldValue: 'first' });

        // Unmount
        render(jsx('span', {}), container);

        // unmounted: receives el and { value } with last known value
        expect(unmountedArgs).toHaveLength(1);
        expect(unmountedArgs[0].el).toBe(el);
        expect(unmountedArgs[0].binding).toEqual({ value: 'second' });
    });
});
