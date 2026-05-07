import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('component lifecycle hooks (integration)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('should call onCreated during setup', () => {
        const createdSpy = vi.fn();

        const Comp = component((ctx) => {
            ctx.onCreated(() => {
                createdSpy();
            });
            return () => jsx('div', { children: 'hello' });
        });

        render(jsx(Comp, {}), container);
        expect(createdSpy).toHaveBeenCalledTimes(1);
    });

    it('should call onMounted after DOM insertion', () => {
        const mountedSpy = vi.fn();

        const Comp = component((ctx) => {
            ctx.onMounted(() => {
                // DOM should be available by the time onMounted fires
                mountedSpy(container.textContent);
            });
            return () => jsx('div', { children: 'mounted' });
        });

        render(jsx(Comp, {}), container);
        expect(mountedSpy).toHaveBeenCalledTimes(1);
        // The component's content should already be in the DOM
        expect(mountedSpy).toHaveBeenCalledWith(expect.stringContaining('mounted'));
    });

    it('should call onUpdated after re-render', () => {
        const updatedSpy = vi.fn();
        const count = signal(0);

        const Comp = component((ctx) => {
            ctx.onUpdated(() => {
                updatedSpy();
            });
            return () => jsx('div', { children: String(count.value) });
        });

        render(jsx(Comp, {}), container);
        expect(updatedSpy).not.toHaveBeenCalled();

        // Trigger a reactive update
        count.value = 1;
        expect(updatedSpy).toHaveBeenCalledTimes(1);
    });

    it('should call onUnmounted when component is removed', () => {
        const unmountedSpy = vi.fn();

        const Comp = component((ctx) => {
            ctx.onUnmounted(() => {
                unmountedSpy();
            });
            return () => jsx('div', { children: 'will unmount' });
        });

        render(jsx(Comp, {}), container);
        expect(unmountedSpy).not.toHaveBeenCalled();

        // Unmount by rendering null
        render(null, container);
        expect(unmountedSpy).toHaveBeenCalledTimes(1);
    });

    it('should execute hooks in order: created → mounted → updated → unmounted', () => {
        const order: string[] = [];
        const count = signal(0);

        const Comp = component((ctx) => {
            ctx.onCreated(() => order.push('created'));
            ctx.onMounted(() => order.push('mounted'));
            ctx.onUpdated(() => order.push('updated'));
            ctx.onUnmounted(() => order.push('unmounted'));
            return () => jsx('div', { children: String(count.value) });
        });

        render(jsx(Comp, {}), container);
        expect(order).toEqual(['created', 'mounted']);

        count.value = 1;
        expect(order).toEqual(['created', 'mounted', 'updated']);

        render(null, container);
        expect(order).toEqual(['created', 'mounted', 'updated', 'unmounted']);
    });

    it('should call multiple hooks of same type in registration order', () => {
        const order: number[] = [];

        const Comp = component((ctx) => {
            ctx.onMounted(() => order.push(1));
            ctx.onMounted(() => order.push(2));
            ctx.onMounted(() => order.push(3));
            return () => jsx('div', { children: 'multi' });
        });

        render(jsx(Comp, {}), container);
        expect(order).toEqual([1, 2, 3]);
    });

    it('should pass { el: container } to onMounted', () => {
        let mountCtx: any = null;

        const Comp = component((ctx) => {
            ctx.onMounted((mctx) => {
                mountCtx = mctx;
            });
            return () => jsx('div', { children: 'ctx test' });
        });

        render(jsx(Comp, {}), container);
        expect(mountCtx).not.toBeNull();
        expect(mountCtx.el).toBe(container);
    });

    it('should handle parent-child lifecycle ordering (child mounts before parent)', () => {
        const order: string[] = [];

        const Child = component((ctx) => {
            ctx.onMounted(() => order.push('child-mounted'));
            return () => jsx('span', { children: 'child' });
        });

        const Parent = component((ctx) => {
            ctx.onMounted(() => order.push('parent-mounted'));
            return () => jsx('div', { children: jsx(Child, {}) });
        });

        render(jsx(Parent, {}), container);
        expect(order).toEqual(['child-mounted', 'parent-mounted']);
    });
});
