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

    it('should mount new children of a fragment inside svg with the SVG namespace', () => {
        // Regression: the fragment patch branch used to hardcode a non-SVG
        // context, so a child newly mounted during a fragment patch inside
        // an <svg> was created in the HTML namespace.
        const showSecond = signal(false);

        const Shapes = component(() => {
            return () => (
                <svg>
                    <>
                        <circle cx="10" cy="10" r="5" />
                        {showSecond.value ? <rect x="0" y="0" width="4" height="4" /> : null}
                    </>
                </svg>
            );
        });

        render(<Shapes />, container);
        expect(container.querySelector('circle')!.namespaceURI).toBe(SVG_NS);
        expect(container.querySelector('rect')).toBeNull();

        showSecond.value = true;

        const rect = container.querySelector('rect')!;
        expect(rect).toBeTruthy();
        expect(rect.namespaceURI).toBe(SVG_NS);
    });

    it('should mount a type-replacement inside svg with the SVG namespace', () => {
        // A child component swapping its ROOT element type re-renders via
        // patch(oldSubTree, newSubTree) with no threaded SVG context and hits
        // patch()'s replacement branch. The old vnode's cached namespace flag
        // must carry the context so the replacement stays SVG.
        const useRect = signal(false);
        const Shape = component(() => {
            return () =>
                useRect.value
                    ? <rect x="0" y="0" width="4" height="4" />
                    : <circle cx="10" cy="10" r="5" />;
        });
        const App = component(() => {
            return () => (
                <svg>
                    <Shape />
                </svg>
            );
        });

        render(<App />, container);
        expect(container.querySelector('circle')!.namespaceURI).toBe(SVG_NS);

        useRect.value = true;

        const rect = container.querySelector('rect')!;
        expect(rect).toBeTruthy();
        expect(rect.namespaceURI).toBe(SVG_NS);
    });

    it('should keep patching an svg child down the SVG path after re-renders', () => {
        const cls = signal('a');
        const Iconish = component(() => {
            return () => (
                <svg>
                    <text class={cls.value}>label</text>
                </svg>
            );
        });

        render(<Iconish />, container);
        const text = container.querySelector('text')!;
        expect(text.namespaceURI).toBe(SVG_NS);
        expect(text.getAttribute('class')).toBe('a');

        cls.value = 'b';
        expect(container.querySelector('text')!.getAttribute('class')).toBe('b');
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
