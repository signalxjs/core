/**
 * Event handler cleanup tests
 *
 * Validates that event handler Maps stored on DOM elements are properly
 * cleaned up when elements are unmounted to prevent memory leaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, signal } from 'sigx';

describe('event handler cleanup', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should clean up __sigx_event_handlers on unmount', () => {
        const clicked = signal(false);

        const App = component(() => {
            return () => jsx('button', { onClick: () => clicked.value = true }, 'Click');
        });

        render(jsx(App, {}), container);
        const button = container.querySelector('button')!;

        // Handler map should exist after mount
        expect((button as any).__sigx_event_handlers).toBeInstanceOf(Map);
        expect((button as any).__sigx_event_handlers.size).toBe(1);

        // Unmount the app
        render(null as any, container);

        // Handler map should be cleaned up
        expect((button as any).__sigx_event_handlers).toBeUndefined();
    });

    it('should remove event listeners on unmount', () => {
        const calls: string[] = [];

        const App = component(() => {
            return () => jsx('button', {
                onClick: () => calls.push('click'),
                onMouseenter: () => calls.push('mouseenter'),
            }, 'Hover me');
        });

        render(jsx(App, {}), container);
        const button = container.querySelector('button')!;

        // Both handlers should be registered
        expect((button as any).__sigx_event_handlers.size).toBe(2);

        // Unmount
        render(null as any, container);

        // Firing events after unmount should not trigger handlers
        button.dispatchEvent(new Event('click'));
        button.dispatchEvent(new Event('mouseenter'));
        expect(calls).toEqual([]);
    });

    it('should clean up handlers when conditional rendering removes element', () => {
        const show = signal(true);

        const App = component(() => {
            return () => show.value
                ? jsx('button', { onClick: () => {} }, 'Visible')
                : jsx('span', {}, 'Hidden');
        });

        render(jsx(App, {}), container);
        const button = container.querySelector('button')!;
        expect((button as any).__sigx_event_handlers).toBeInstanceOf(Map);

        // Toggle off — button should be unmounted and cleaned up
        show.value = false;

        expect((button as any).__sigx_event_handlers).toBeUndefined();
        expect(container.querySelector('button')).toBeNull();
    });
});
