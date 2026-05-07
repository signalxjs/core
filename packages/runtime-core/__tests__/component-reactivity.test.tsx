import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx, Fragment } from '@sigx/runtime-core';
import { signal, computed, batch } from '@sigx/reactivity';

describe('component reactivity (integration)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('should re-render when signal value changes', () => {
        const count = signal(0);

        const Comp = component(() => {
            return () => jsx('div', { children: String(count.value) });
        });

        render(jsx(Comp, {}), container);
        expect(container.textContent).toBe('0');

        count.value = 5;
        expect(container.textContent).toBe('5');
    });

    it('should update child component when parent passes new props', () => {
        const Child = component<{ value: number }>((ctx) => {
            return () => jsx('span', { children: String(ctx.props.value) });
        });

        const parentCount = signal(10);

        const Parent = component(() => {
            return () => jsx('div', {
                children: jsx(Child, { value: parentCount.value })
            });
        });

        render(jsx(Parent, {}), container);
        expect(container.textContent).toBe('10');

        parentCount.value = 20;
        expect(container.textContent).toBe('20');
    });

    it('should update computed values reactively', () => {
        const count = signal(3);
        const doubled = computed(() => count.value * 2);

        const Comp = component(() => {
            return () => jsx('div', { children: String(doubled.value) });
        });

        render(jsx(Comp, {}), container);
        expect(container.textContent).toBe('6');

        count.value = 7;
        expect(container.textContent).toBe('14');
    });

    it('should batch multiple signal changes into single re-render', () => {
        const a = signal(0);
        const b = signal(0);
        let renderCount = 0;

        const Comp = component(() => {
            return () => {
                renderCount++;
                return jsx('div', { children: `${a.value}-${b.value}` });
            };
        });

        render(jsx(Comp, {}), container);
        expect(renderCount).toBe(1);
        expect(container.textContent).toBe('0-0');

        batch(() => {
            a.value = 1;
            b.value = 2;
        });

        expect(container.textContent).toBe('1-2');
        expect(renderCount).toBe(2); // initial + one batched re-render
    });

    it('should unmount subtree when render returns null', () => {
        const visible = signal(true);

        const Comp = component(() => {
            return () => visible.value ? jsx('div', { children: 'content' }) : null;
        });

        render(jsx(Comp, {}), container);
        expect(container.textContent).toBe('content');

        visible.value = false;
        expect(container.textContent).toBe('');

        visible.value = true;
        expect(container.textContent).toBe('content');
    });

    it('should handle render returning array as Fragment', () => {
        const Comp = component(() => {
            return () => [
                jsx('span', { children: 'a' }),
                jsx('span', { children: 'b' })
            ];
        });

        render(jsx(Comp, {}), container);
        const spans = container.querySelectorAll('span');
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe('a');
        expect(spans[1].textContent).toBe('b');
    });

    it('should make exposed value available via ref', () => {
        let refValue: any = null;

        const Child = component((ctx) => {
            (ctx.expose as any)({ getValue: () => 42 });
            return () => jsx('div', { children: 'exposed' });
        });

        const Parent = component(() => {
            return () => jsx(Child, {
                ref: (val: any) => { refValue = val; }
            });
        });

        render(jsx(Parent, {}), container);
        expect(refValue).not.toBeNull();
        expect(refValue.getValue()).toBe(42);
    });
});
