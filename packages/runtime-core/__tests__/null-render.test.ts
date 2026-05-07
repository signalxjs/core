/**
 * Tests for component render returning null.
 * 
 * Verifies that when a component's render function transitions from returning
 * content to returning null, the previous subtree is properly unmounted
 * (not left stale in the DOM).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('Component render null transition', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'app';
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('should unmount subtree when render transitions from content to null', () => {
        const show = signal(true);

        const Conditional = component(() => {
            return () => {
                if (show.value) {
                    return jsx('div', { class: 'content', children: 'Hello' });
                }
                return null;
            };
        }, { name: 'Conditional' });

        render(jsx(Conditional, {}), container);

        // Content should be rendered
        expect(container.querySelectorAll('.content').length).toBe(1);
        expect(container.textContent).toContain('Hello');

        // Toggle to null — content should be unmounted
        show.value = false;

        expect(container.querySelectorAll('.content').length).toBe(0);
        expect(container.textContent).not.toContain('Hello');
    });

    it('should re-mount subtree when render transitions from null back to content', () => {
        const show = signal(true);

        const Conditional = component(() => {
            return () => {
                if (show.value) {
                    return jsx('div', { class: 'content', children: 'Hello' });
                }
                return null;
            };
        }, { name: 'Conditional' });

        render(jsx(Conditional, {}), container);
        expect(container.querySelectorAll('.content').length).toBe(1);

        // Toggle to null
        show.value = false;
        expect(container.querySelectorAll('.content').length).toBe(0);

        // Toggle back to content — should re-mount cleanly (not duplicate)
        show.value = true;
        expect(container.querySelectorAll('.content').length).toBe(1);
        expect(container.textContent).toContain('Hello');
    });

    it('should not leave stale content when toggling rapidly', () => {
        const show = signal(true);

        const Conditional = component(() => {
            return () => {
                if (show.value) {
                    return jsx('div', { class: 'content', children: 'Visible' });
                }
                return null;
            };
        }, { name: 'Conditional' });

        render(jsx(Conditional, {}), container);

        // Rapid toggling
        show.value = false;
        show.value = true;
        show.value = false;
        show.value = true;

        // Should have exactly one .content element, no stacking
        expect(container.querySelectorAll('.content').length).toBe(1);
    });

    it('should handle component that starts with null render', () => {
        const show = signal(false);

        const Conditional = component(() => {
            return () => {
                if (show.value) {
                    return jsx('div', { class: 'content', children: 'Appeared' });
                }
                return null;
            };
        }, { name: 'Conditional' });

        render(jsx(Conditional, {}), container);

        // Initially null — no content
        expect(container.querySelectorAll('.content').length).toBe(0);

        // Toggle to visible — should mount once
        show.value = true;
        expect(container.querySelectorAll('.content').length).toBe(1);

        // Toggle back to null — should unmount
        show.value = false;
        expect(container.querySelectorAll('.content').length).toBe(0);

        // Toggle to visible again — should mount once (not stack)
        show.value = true;
        expect(container.querySelectorAll('.content').length).toBe(1);
    });
});
