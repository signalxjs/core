/**
 * Built-in `show` directive tests
 *
 * Tests that use:show toggles element visibility via display CSS property.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { show } from '../src/directives/show';
import { jsx, signal } from 'sigx';

describe('show directive', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should hide element when value is false', () => {
        render(jsx('div', { 'use:show': [show, false], id: 'target' }), container);

        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).toBe('none');
    });

    it('should show element when value is true', () => {
        render(jsx('div', { 'use:show': [show, true], id: 'target' }), container);

        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).not.toBe('none');
    });

    it('should toggle display on re-render', () => {
        render(jsx('div', { 'use:show': [show, true], id: 'target' }), container);
        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).not.toBe('none');

        render(jsx('div', { 'use:show': [show, false], id: 'target' }), container);
        expect(el.style.display).toBe('none');

        render(jsx('div', { 'use:show': [show, true], id: 'target' }), container);
        expect(el.style.display).not.toBe('none');
    });

    it('should preserve original display value', () => {
        // First render visible — show captures the display value at mounted time
        render(jsx('div', {
            'use:show': [show, true],
            style: { display: 'flex' },
            id: 'target'
        }), container);

        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).toBe('flex');

        // Hide — show saves 'flex' and sets 'none'
        render(jsx('div', {
            'use:show': [show, false],
            id: 'target'
        }), container);
        expect(el.style.display).toBe('none');

        // Show again — should restore to 'flex'
        render(jsx('div', {
            'use:show': [show, true],
            id: 'target'
        }), container);
        expect(el.style.display).toBe('flex');
    });

    it('should keep element in the DOM when hidden', () => {
        render(jsx('div', { 'use:show': [show, false], id: 'target' }), container);

        const el = container.querySelector('#target');
        expect(el).not.toBeNull();
        expect(document.body.contains(el)).toBe(true);
    });

    it('should work with default display (empty string)', () => {
        render(jsx('div', { 'use:show': [show, false], id: 'target' }), container);
        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).toBe('none');

        render(jsx('div', { 'use:show': [show, true], id: 'target' }), container);
        // Default display should be empty string (browser default)
        expect(el.style.display).toBe('');
    });

    it('should hide element with shorthand boolean false', () => {
        render(jsx('div', { 'use:show': false, id: 'target' }), container);

        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).toBe('none');
    });

    it('should show element with shorthand boolean true', () => {
        render(jsx('div', { 'use:show': true, id: 'target' }), container);

        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).not.toBe('none');
    });

    it('should toggle display with shorthand boolean', () => {
        render(jsx('div', { 'use:show': true, id: 'target' }), container);
        const el = container.querySelector('#target') as HTMLElement;
        expect(el.style.display).not.toBe('none');

        render(jsx('div', { 'use:show': false, id: 'target' }), container);
        expect(el.style.display).toBe('none');

        render(jsx('div', { 'use:show': true, id: 'target' }), container);
        expect(el.style.display).not.toBe('none');
    });
});
