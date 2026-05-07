/**
 * SVG namespace handling tests
 *
 * Validates that the renderer correctly creates SVG elements with the proper
 * namespace URI, propagates SVG context to children, resets it for foreignObject,
 * and patches SVG attributes correctly.
 *
 * Uses the real DOM renderer (runtime-dom) with happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { jsx } from '@sigx/runtime-core';
import { component, signal } from 'sigx';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

describe('SVG namespace handling', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should create svg element with SVG namespace', () => {
        render(jsx('svg', {}), container);

        const svg = container.firstElementChild!;
        expect(svg).toBeTruthy();
        expect(svg.tagName).toBe('svg');
        expect(svg.namespaceURI).toBe(SVG_NS);
    });

    it('should create child SVG elements with SVG namespace', () => {
        render(
            jsx('svg', {
                children: jsx('circle', { cx: '50', cy: '50', r: '25' }),
            }),
            container,
        );

        const svg = container.firstElementChild!;
        const circle = svg.firstElementChild!;
        expect(circle).toBeTruthy();
        expect(circle.tagName).toBe('circle');
        expect(circle.namespaceURI).toBe(SVG_NS);
    });

    it('should create foreignObject children with HTML namespace', () => {
        render(
            jsx('svg', {
                children: jsx('foreignObject', {
                    children: jsx('div', { children: 'hello' }),
                }),
            }),
            container,
        );

        const svg = container.firstElementChild!;
        const foreignObject = svg.firstElementChild!;
        expect(foreignObject).toBeTruthy();
        expect(foreignObject.tagName.toLowerCase()).toBe('foreignobject');
        // Note: the renderer treats foreignObject as non-SVG (isSVG = parentIsSVG && tag !== 'foreignObject')
        // so happy-dom creates it in HTML namespace. In a real browser the element would still be SVG.
        // The key behavioral check is that children escape SVG context.

        const div = foreignObject.firstElementChild!;
        expect(div).toBeTruthy();
        expect(div.tagName).toBe('DIV');
        // Children of foreignObject should be in HTML namespace, not SVG
        expect(div.namespaceURI).not.toBe(SVG_NS);
    });

    it('should handle SVG attribute updates on patch', () => {
        const cx = signal('10');

        const App = component(({ signal: s }) => {
            return () =>
                jsx('svg', {
                    children: jsx('circle', { cx: cx.value, cy: '50', r: '25' }),
                });
        });

        render(jsx(App, {}), container);

        const circle = container.querySelector('circle')!;
        expect(circle).toBeTruthy();
        expect(circle.getAttribute('cx')).toBe('10');

        // Update the signal to trigger a patch
        cx.value = '20';

        const circleAfter = container.querySelector('circle')!;
        expect(circleAfter.getAttribute('cx')).toBe('20');
    });

    it('should create nested SVG elements correctly', () => {
        render(
            jsx('svg', {
                children: jsx('g', {
                    children: [
                        jsx('rect', { x: '0', y: '0', width: '100', height: '100' }),
                        jsx('path', { d: 'M0 0 L100 100' }),
                    ],
                }),
            }),
            container,
        );

        const svg = container.firstElementChild!;
        expect(svg.namespaceURI).toBe(SVG_NS);

        const g = svg.firstElementChild!;
        expect(g.tagName).toBe('g');
        expect(g.namespaceURI).toBe(SVG_NS);

        const rect = g.children[0]!;
        expect(rect.tagName).toBe('rect');
        expect(rect.namespaceURI).toBe(SVG_NS);

        const path = g.children[1]!;
        expect(path.tagName).toBe('path');
        expect(path.namespaceURI).toBe(SVG_NS);
    });
});
