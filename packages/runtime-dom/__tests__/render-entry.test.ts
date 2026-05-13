import { describe, it, expect, afterEach } from 'vitest';
import { render } from '../src/render';
import { component } from '@sigx/runtime-core';

const containers: HTMLElement[] = [];

function makeContainer(id: string): HTMLDivElement {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    containers.push(el);
    return el;
}

afterEach(() => {
    while (containers.length) {
        const el = containers.pop()!;
        if (el.parentNode) el.parentNode.removeChild(el);
    }
});

const Hello = component(() => () => {
    return {
        type: 'div',
        props: { class: 'hello' },
        key: null,
        children: [],
        dom: null,
        text: 'hi'
    } as any;
}, { name: 'Hello' });

describe('render() — DOM entry point', () => {
    it('throws renderTargetNotFoundError when CSS selector matches nothing', () => {
        expect(() => render((Hello as any)({}), '#definitely-missing')).toThrow(
            /Render target "#definitely-missing" not found/
        );
    });

    it('resolves a CSS selector to an element and renders into it', () => {
        const container = makeContainer('render-entry-target');
        render((Hello as any)({}), '#render-entry-target');
        expect(container.querySelector('.hello')).not.toBeNull();
    });

    it('renders into a direct Element reference', () => {
        const container = makeContainer('render-direct');
        render((Hello as any)({}), container);
        expect(container.querySelector('.hello')).not.toBeNull();
    });

    it('unmounts when called with null vnode on the same target', () => {
        const container = makeContainer('render-unmount');
        render((Hello as any)({}), container);
        expect(container.querySelector('.hello')).not.toBeNull();

        render(null as any, container);
        expect(container.querySelector('.hello')).toBeNull();
    });
});
