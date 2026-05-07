import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, Fragment } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('mixed VNode type trees', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should render a tree with mixed elements, components, and text', () => {
        const SimpleComp = component(() => {
            return () => jsx('span', { children: 'from component' });
        });

        render(jsx('div', {
            children: [
                jsx('p', { children: 'text element' }),
                jsx(SimpleComp, {}),
                'raw text',
                jsx('button', { children: 'click' }),
            ],
        }), container);

        const div = container.querySelector('div')!;
        expect(div).toBeTruthy();

        const p = div.querySelector('p')!;
        expect(p.textContent).toBe('text element');

        const span = div.querySelector('span')!;
        expect(span.textContent).toBe('from component');

        const button = div.querySelector('button')!;
        expect(button.textContent).toBe('click');

        // Verify ordering: p, component anchor + span, text node, button
        const childNodes = Array.from(div.childNodes);
        const elementAndTextNodes = childNodes.filter(
            n => n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE,
        );
        const texts = elementAndTextNodes.map(n => n.textContent);
        expect(texts).toEqual(['text element', 'from component', 'raw text', 'click']);
    });

    it('should mount, patch, and unmount a mixed tree', () => {
        const Greeting = component(() => {
            return () => jsx('em', { children: 'hello' });
        });

        // Mount
        render(jsx('div', {
            children: [
                jsx('p', { children: 'first' }),
                jsx(Greeting, {}),
            ],
        }), container);

        expect(container.querySelector('p')!.textContent).toBe('first');
        expect(container.querySelector('em')!.textContent).toBe('hello');

        // Patch with different children
        render(jsx('div', {
            children: [
                jsx('span', { children: 'replaced' }),
                jsx('strong', { children: 'new element' }),
            ],
        }), container);

        expect(container.querySelector('p')).toBeNull();
        expect(container.querySelector('em')).toBeNull();
        expect(container.querySelector('span')!.textContent).toBe('replaced');
        expect(container.querySelector('strong')!.textContent).toBe('new element');

        // Unmount
        render(null as any, container);

        // Container should have no element children left
        expect(container.querySelector('div')).toBeNull();
        expect(container.children.length).toBe(0);
    });

    it('should render Fragment with mixed child types', () => {
        const SimpleComp = component(() => {
            return () => jsx('span', { children: 'comp child' });
        });

        render(jsx(Fragment, {
            children: [
                jsx('p', { children: 'text' }),
                jsx(SimpleComp, {}),
                'plain text',
                null,
            ],
        }), container);

        const p = container.querySelector('p')!;
        expect(p.textContent).toBe('text');

        const span = container.querySelector('span')!;
        expect(span.textContent).toBe('comp child');

        // Check that plain text is present somewhere in the container
        expect(container.textContent).toContain('plain text');

        // null child becomes a Comment placeholder
        const comments = Array.from(container.childNodes).filter(
            n => n.nodeType === Node.COMMENT_NODE,
        );
        expect(comments.length).toBeGreaterThanOrEqual(1);
    });

    it('should render nested Fragments', () => {
        render(jsx(Fragment, {
            children: [
                jsx(Fragment, {
                    children: [
                        jsx('span', { children: 'a' }),
                        jsx('span', { children: 'b' }),
                    ],
                }),
                jsx('div', { children: 'c' }),
            ],
        }), container);

        const spans = container.querySelectorAll('span');
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe('a');
        expect(spans[1].textContent).toBe('b');

        const div = container.querySelector('div')!;
        expect(div.textContent).toBe('c');

        // All nodes are direct children of container (flattened, no wrapper)
        const elementChildren = Array.from(container.childNodes).filter(
            n => n.nodeType === Node.ELEMENT_NODE,
        );
        expect(elementChildren.length).toBe(3);
    });

    it('should handle conditional rendering with null and boolean children', async () => {
        const show = signal(true);

        const Comp = component(() => {
            return () => jsx('div', {
                children: [
                    show.value ? jsx('p', { children: 'visible' }) : null,
                    jsx('span', { children: 'always' }),
                ],
            });
        });

        render(jsx(Comp, {}), container);

        const div = container.querySelector('div')!;
        expect(div.querySelector('p')!.textContent).toBe('visible');
        expect(div.querySelector('span')!.textContent).toBe('always');

        // Toggle signal off
        show.value = false;
        await nextTick();

        expect(div.querySelector('p')).toBeNull();
        expect(div.querySelector('span')!.textContent).toBe('always');

        // Toggle signal back on
        show.value = true;
        await nextTick();

        expect(div.querySelector('p')!.textContent).toBe('visible');
        expect(div.querySelector('span')!.textContent).toBe('always');
    });
});
