/**
 * Focus preservation tests — DOM patching must not steal focus
 *
 * Validates that when sigx patches DOM attributes on focusable sibling
 * elements during a reactive re-render, the currently focused element
 * retains focus. This reproduces the bug documented in
 * sigx-focus-stealing-bug.md.
 *
 * Since happy-dom does not simulate browser focus-stealing on setAttribute,
 * we simulate it by temporarily monkey-patching Element.prototype.setAttribute
 * to shift focus when a focusable element's class is changed — mimicking real
 * browser behavior. The fix in sigx should save/restore activeElement around
 * the patch cycle, making these tests pass.
 *
 * Uses the real DOM renderer (runtime-dom) with happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, jsx, signal } from 'sigx';

/**
 * Simulate browser focus-stealing: when setAttribute('class', ...) is called
 * on a focusable element (button, input, a[href], [tabindex]), shift focus
 * to that element — mimicking the real browser behavior that causes the bug.
 */
function installFocusStealingSimulation() {
    const original = Element.prototype.setAttribute;
    const focusableTags = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);

    Element.prototype.setAttribute = function (name: string, value: string) {
        original.call(this, name, value);
        // Simulate focus steal on class attribute change for focusable elements
        if (name === 'class' && this instanceof HTMLElement) {
            if (focusableTags.has(this.tagName) || this.hasAttribute('tabindex')) {
                const active = document.activeElement;
                if (active && active !== this && active !== document.body) {
                    // Simulate: browser steals focus to this element
                    this.focus();
                }
            }
        }
    };

    return () => {
        Element.prototype.setAttribute = original;
    };
}

describe('focus preservation during patch', () => {
    let container: HTMLElement;
    let cleanupSimulation: (() => void) | null = null;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        cleanupSimulation = installFocusStealingSimulation();
    });

    afterEach(() => {
        cleanupSimulation?.();
        cleanupSimulation = null;
        render(null as any, container);
        container.remove();
    });

    it('should not steal focus from contenteditable when patching sibling button class', () => {
        const state = signal({ active: false });

        const App = component(() => {
            return () => jsx('div', {
                className: 'relative',
                children: [
                    jsx('div', {
                        contentEditable: true,
                        className: 'input',
                        onFocus: () => { state.active = true; },
                        onBlur: () => { state.active = false; },
                    }),
                    jsx('button', {
                        className: `btn ${state.active ? 'btn-active' : ''}`,
                        children: 'Toggle'
                    })
                ]
            });
        });

        render(jsx(App, {}), container);

        const editor = container.querySelector('[contenteditable]') as HTMLDivElement;
        const button = container.querySelector('button') as HTMLButtonElement;

        expect(editor).toBeTruthy();
        expect(button).toBeTruthy();

        // Focus the editor
        editor.focus();

        // The onFocus handler sets state.active = true, which triggers a re-render
        // that patches the button's className. This should NOT steal focus.
        expect(document.activeElement).toBe(editor);
        expect(button.getAttribute('class')).toBe('btn btn-active');
    });

    it('should not steal focus from input when patching sibling button class', () => {
        const state = signal({ focused: false });

        const App = component(() => {
            return () => jsx('div', {
                children: [
                    jsx('input', {
                        type: 'text',
                        onFocus: () => { state.focused = true; },
                        onBlur: () => { state.focused = false; },
                    }),
                    jsx('button', {
                        className: state.focused ? 'active' : 'inactive',
                        children: 'Action'
                    })
                ]
            });
        });

        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        const button = container.querySelector('button') as HTMLButtonElement;

        input.focus();

        expect(document.activeElement).toBe(input);
        expect(button.getAttribute('class')).toBe('active');
    });

    it('should not steal focus when patching data attributes on sibling focusable elements', () => {
        const state = signal({ highlighted: false });

        const App = component(() => {
            return () => jsx('div', {
                children: [
                    jsx('textarea', {
                        onFocus: () => { state.highlighted = true; },
                        onBlur: () => { state.highlighted = false; },
                    }),
                    jsx('a', {
                        href: '#',
                        'data-highlight': state.highlighted ? 'true' : 'false',
                        children: 'Link'
                    })
                ]
            });
        });

        render(jsx(App, {}), container);

        const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
        const link = container.querySelector('a') as HTMLAnchorElement;

        textarea.focus();

        expect(document.activeElement).toBe(textarea);
        expect(link.getAttribute('data-highlight')).toBe('true');
    });

    it('should preserve focus when multiple sibling elements are patched', () => {
        const state = signal({ editing: false });

        const App = component(() => {
            return () => jsx('div', {
                children: [
                    jsx('div', {
                        contentEditable: true,
                        onFocus: () => { state.editing = true; },
                        onBlur: () => { state.editing = false; },
                    }),
                    jsx('button', {
                        className: state.editing ? 'save-active' : 'save',
                        children: 'Save'
                    }),
                    jsx('button', {
                        className: state.editing ? 'cancel-active' : 'cancel',
                        children: 'Cancel'
                    })
                ]
            });
        });

        render(jsx(App, {}), container);

        const editor = container.querySelector('[contenteditable]') as HTMLDivElement;
        const buttons = container.querySelectorAll('button');

        editor.focus();

        expect(document.activeElement).toBe(editor);
        expect(buttons[0].getAttribute('class')).toBe('save-active');
        expect(buttons[1].getAttribute('class')).toBe('cancel-active');
    });

    it('should preserve focus when patching non-class attributes on focusable siblings', () => {
        const state = signal({ active: false });

        const App = component(() => {
            return () => jsx('div', {
                children: [
                    jsx('input', {
                        type: 'text',
                        onFocus: () => { state.active = true; },
                        onBlur: () => { state.active = false; },
                    }),
                    jsx('button', {
                        disabled: !state.active,
                        children: 'Submit'
                    })
                ]
            });
        });

        render(jsx(App, {}), container);

        const input = container.querySelector('input') as HTMLInputElement;
        const button = container.querySelector('button') as HTMLButtonElement;

        // Button should be disabled initially
        expect(button.disabled).toBe(true);

        input.focus();

        // After focus, button should be enabled, and input should keep focus
        expect(document.activeElement).toBe(input);
        expect(button.disabled).toBe(false);
    });
});
