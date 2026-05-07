import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Portal, supportsMoveBefore, moveNode, render } from '../src/index';
import { component, jsx, Fragment } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('Portal utilities', () => {
    describe('supportsMoveBefore', () => {
        it('should return a boolean', () => {
            const result = supportsMoveBefore();
            expect(typeof result).toBe('boolean');
        });

        it('should return false in happy-dom (no moveBefore support)', () => {
            // happy-dom doesn't implement moveBefore
            expect(supportsMoveBefore()).toBe(false);
        });
    });

    describe('moveNode', () => {
        let container: HTMLElement;
        let targetContainer: HTMLElement;

        beforeEach(() => {
            container = document.createElement('div');
            targetContainer = document.createElement('div');
            document.body.appendChild(container);
            document.body.appendChild(targetContainer);
        });

        afterEach(() => {
            container.remove();
            targetContainer.remove();
        });

        it('should insert a node into a parent using insertBefore fallback', () => {
            const node = document.createElement('span');
            node.textContent = 'Test';

            moveNode(targetContainer, node);

            expect(targetContainer.contains(node)).toBe(true);
            expect(targetContainer.firstChild).toBe(node);
        });

        it('should insert a node before an anchor', () => {
            const anchor = document.createElement('div');
            anchor.textContent = 'Anchor';
            targetContainer.appendChild(anchor);

            const node = document.createElement('span');
            node.textContent = 'Test';

            moveNode(targetContainer, node, anchor);

            expect(targetContainer.firstChild).toBe(node);
            expect(targetContainer.lastChild).toBe(anchor);
        });
    });
});

describe('Portal component', () => {
    let container: HTMLElement;
    let portalTarget: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'app';
        portalTarget = document.createElement('div');
        portalTarget.id = 'portal-target';
        document.body.appendChild(container);
        document.body.appendChild(portalTarget);
    });

    afterEach(() => {
        container.remove();
        portalTarget.remove();
        // Clean up any portal containers
        document.querySelectorAll('[data-sigx-portal]').forEach(el => el.remove());
    });

    it('should render children to document.body by default', async () => {
        const TestComponent = component(() => {
            return () => jsx(Portal, {
                children: jsx('div', { class: 'modal', children: 'Modal Content' })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for onMounted effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check that portal container exists in body
        const portalContainer = document.querySelector('[data-sigx-portal]');
        expect(portalContainer).toBeTruthy();
        expect(portalContainer?.parentElement).toBe(document.body);

        // Check that content is rendered inside portal container
        const modal = portalContainer?.querySelector('.modal');
        expect(modal).toBeTruthy();
        expect(modal?.textContent).toBe('Modal Content');
    });

    it('should render children to a specified target container (by selector)', async () => {
        const TestComponent = component(() => {
            return () => jsx(Portal, {
                to: '#portal-target',
                children: jsx('div', { class: 'modal', children: 'Modal Content' })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for onMounted effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check that portal container exists in target
        const portalContainer = portalTarget.querySelector('[data-sigx-portal]');
        expect(portalContainer).toBeTruthy();

        // Check that content is rendered inside portal container
        const modal = portalContainer?.querySelector('.modal');
        expect(modal).toBeTruthy();
        expect(modal?.textContent).toBe('Modal Content');
    });

    it('should render children in place when disabled', async () => {
        const TestComponent = component(() => {
            return () => jsx(Portal, {
                disabled: true,
                children: jsx('div', { class: 'modal', children: 'Modal Content' })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check that no portal container was created
        const portalContainer = document.querySelector('[data-sigx-portal]');
        expect(portalContainer).toBeFalsy();

        // Check that content is rendered in the original container
        const modal = container.querySelector('.modal');
        expect(modal).toBeTruthy();
        expect(modal?.textContent).toBe('Modal Content');
    });

    it('should fall back to document.body when selector not found', async () => {
        // Spy on console.warn
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const TestComponent = component(() => {
            return () => jsx(Portal, {
                to: '#nonexistent-target',
                children: jsx('div', { class: 'modal', children: 'Modal Content' })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for onMounted effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Should warn about missing target
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('#nonexistent-target')
        );

        // Should fall back to document.body
        const portalContainer = document.querySelector('body > [data-sigx-portal]');
        expect(portalContainer).toBeTruthy();

        warnSpy.mockRestore();
    });

    it('should clean up portal container on unmount', async () => {
        const TestComponent = component(() => {
            return () => jsx(Portal, {
                to: '#portal-target',
                children: jsx('div', { class: 'modal', children: 'Modal Content' })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for onMounted effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify portal is mounted
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeTruthy();

        // Unmount by rendering null
        render(null as any, container);

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal container should be removed
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeFalsy();
    });

    it('should reactively update portal content', async () => {
        const state = signal({ text: 'Initial' });

        const TestComponent = component(() => {
            return () => jsx(Portal, {
                to: '#portal-target',
                children: jsx('div', { class: 'modal', children: state.text })
            });
        });

        render(jsx(TestComponent, {}), container);

        // Wait for onMounted effects
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check initial content
        const modal = portalTarget.querySelector('.modal');
        expect(modal?.textContent).toBe('Initial');

        // Update state
        state.text = 'Updated';

        // Wait for reactive update
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check updated content
        expect(modal?.textContent).toBe('Updated');
    });
});

describe('Portal conditional cleanup (reactivity bug investigation)', () => {
    let container: HTMLElement;
    let portalTarget: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'app';
        portalTarget = document.createElement('div');
        portalTarget.id = 'portal-target';
        document.body.appendChild(container);
        document.body.appendChild(portalTarget);
    });

    afterEach(() => {
        container.remove();
        portalTarget.remove();
        document.querySelectorAll('[data-sigx-portal]').forEach(el => el.remove());
    });

    it('should clean up portal container when conditionally hidden via signal (show && <Portal>)', async () => {
        const show = signal({ value: true });

        const TestComponent = component(() => {
            return () => show.value
                ? jsx(Portal, {
                    to: '#portal-target',
                    children: jsx('div', { class: 'picker', children: 'Picker Content' })
                  })
                : null;
        });

        render(jsx(TestComponent, {}), container);
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal should be mounted
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeTruthy();
        expect(portalTarget.querySelector('.picker')).toBeTruthy();
        expect(portalTarget.querySelector('.picker')?.textContent).toBe('Picker Content');

        // Hide the portal via signal
        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal container should be removed from the target
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeFalsy();
        expect(portalTarget.querySelector('.picker')).toBeFalsy();
    });

    it('should stop internal reactive effect when portal is conditionally unmounted', async () => {
        const show = signal({ value: true });
        const content = signal({ text: 'Initial' });
        let renderCount = 0;

        const PortalChild = component(() => {
            return () => {
                renderCount++;
                return jsx('div', { class: 'reactive-child', children: content.text });
            };
        });

        const TestComponent = component(() => {
            return () => show.value
                ? jsx(Portal, {
                    to: '#portal-target',
                    children: jsx(PortalChild, {})
                  })
                : null;
        });

        render(jsx(TestComponent, {}), container);
        await new Promise(resolve => setTimeout(resolve, 0));

        const initialRenderCount = renderCount;
        expect(portalTarget.querySelector('.reactive-child')?.textContent).toBe('Initial');

        // Hide the portal
        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        const afterHideCount = renderCount;

        // Update the signal that was used inside the portal
        content.text = 'Updated after unmount';
        await new Promise(resolve => setTimeout(resolve, 0));

        // The render count should NOT increase — the effect should be stopped
        expect(renderCount).toBe(afterHideCount);
        // No portal content in DOM
        expect(portalTarget.querySelector('.reactive-child')).toBeFalsy();
    });

    it('should handle rapid show/hide toggling without leaking DOM elements', async () => {
        const show = signal({ value: true });

        const TestComponent = component(() => {
            return () => show.value
                ? jsx(Portal, {
                    to: '#portal-target',
                    children: jsx('div', { class: 'toggled', children: 'Content' })
                  })
                : null;
        });

        render(jsx(TestComponent, {}), container);
        await new Promise(resolve => setTimeout(resolve, 0));

        // Rapid toggles
        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        show.value = true;
        await new Promise(resolve => setTimeout(resolve, 0));

        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        show.value = true;
        await new Promise(resolve => setTimeout(resolve, 0));

        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        // After final hide: no portal containers should remain
        const portalContainers = portalTarget.querySelectorAll('[data-sigx-portal]');
        expect(portalContainers.length).toBe(0);
        expect(portalTarget.querySelector('.toggled')).toBeFalsy();
    });

    it('should clean up portal when nested inside a conditionally rendered wrapper', async () => {
        const show = signal({ value: true });

        const Wrapper = component(({ slots }) => {
            return () => jsx('div', { class: 'wrapper', children: slots.default() });
        });

        const TestComponent = component(() => {
            return () => show.value
                ? jsx(Wrapper, {
                    children: jsx(Portal, {
                        to: '#portal-target',
                        children: jsx('div', { class: 'nested-portal', children: 'Nested Content' })
                    })
                  })
                : null;
        });

        render(jsx(TestComponent, {}), container);
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal should be mounted
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeTruthy();
        expect(portalTarget.querySelector('.nested-portal')).toBeTruthy();

        // Hide the wrapper (and portal inside it)
        show.value = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal container should be cleaned up
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeFalsy();
        expect(portalTarget.querySelector('.nested-portal')).toBeFalsy();
    });

    it('should clean up portal when outside click handler sets showPicker = false', async () => {
        const state = signal({ showPicker: true });

        // Simulate the pattern: a component with an outside-click handler
        // that hides a Portal-based picker
        const handleOutsideClick = () => {
            state.showPicker = false;
        };

        const PickerComponent = component(() => {
            return () => jsx('div', {
                children: [
                    jsx('button', { class: 'trigger', children: 'Open Picker' }),
                    state.showPicker
                        ? jsx(Portal, {
                            to: '#portal-target',
                            children: jsx('div', { class: 'picker-dropdown', children: 'Picker Options' })
                          })
                        : null
                ]
            });
        });

        render(jsx(PickerComponent, {}), container);
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal should be mounted with picker content
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeTruthy();
        expect(portalTarget.querySelector('.picker-dropdown')).toBeTruthy();
        expect(portalTarget.querySelector('.picker-dropdown')?.textContent).toBe('Picker Options');

        // Simulate outside click
        handleOutsideClick();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Portal should be fully cleaned up
        expect(portalTarget.querySelector('[data-sigx-portal]')).toBeFalsy();
        expect(portalTarget.querySelector('.picker-dropdown')).toBeFalsy();
    });
});
