import { describe, it, expect } from 'vitest';
import { jsx, jsxs, Fragment, Text, Comment, VNode } from '../src/jsx-runtime';

describe('jsx runtime', () => {
    describe('jsx function', () => {
        it('should create a VNode for intrinsic elements', () => {
            const vnode = jsx('div', { className: 'test' }) as VNode;

            expect(vnode.type).toBe('div');
            expect(vnode.props.className).toBe('test');
            expect(vnode.children).toEqual([]);
            expect(vnode.dom).toBeNull();
        });

        it('should handle children prop', () => {
            const vnode = jsx('div', { children: 'Hello' }) as VNode;

            expect(vnode.type).toBe('div');
            expect(vnode.children.length).toBe(1);
            expect(vnode.children[0].type).toBe(Text);
            expect(vnode.children[0].text).toBe('Hello');
        });

        it('should handle multiple children', () => {
            const vnode = jsx('div', { children: ['Hello', ' ', 'World'] }) as VNode;

            expect(vnode.children.length).toBe(3);
            expect(vnode.children[0].text).toBe('Hello');
            expect(vnode.children[1].text).toBe(' ');
            expect(vnode.children[2].text).toBe('World');
        });

        it('should handle numeric children', () => {
            const vnode = jsx('span', { children: 42 }) as VNode;

            expect(vnode.children.length).toBe(1);
            expect(vnode.children[0].type).toBe(Text);
            expect(vnode.children[0].text).toBe(42);
        });

        it('should handle key prop', () => {
            const vnode = jsx('li', { key: 'item-1' }, 'item-1') as VNode;

            expect(vnode.key).toBe('item-1');
        });

        it('should replace null and undefined children with comment placeholders', () => {
            const vnode = jsx('div', { children: [null, 'Hello', undefined, 'World'] }) as VNode;

            expect(vnode.children.length).toBe(4);
            expect(vnode.children[0].type).toBe(Comment);
            expect(vnode.children[1].text).toBe('Hello');
            expect(vnode.children[2].type).toBe(Comment);
            expect(vnode.children[3].text).toBe('World');
        });

        it('should replace boolean children with comment placeholders', () => {
            const vnode = jsx('div', { children: [true, 'Hello', false, 'World'] }) as VNode;

            expect(vnode.children.length).toBe(4);
            expect(vnode.children[0].type).toBe(Comment);
            expect(vnode.children[1].text).toBe('Hello');
            expect(vnode.children[2].type).toBe(Comment);
            expect(vnode.children[3].text).toBe('World');
        });

        it('should wrap nested arrays as fragments', () => {
            const vnode = jsx('div', { children: [['a', 'b'], 'c'] }) as VNode;

            expect(vnode.children.length).toBe(2);
            expect(vnode.children[0].type).toBe(Fragment);
            expect(vnode.children[0].children.length).toBe(2);
            expect(vnode.children[0].children[0].text).toBe('a');
            expect(vnode.children[0].children[1].text).toBe('b');
            expect(vnode.children[1].text).toBe('c');
        });
    });

    describe('Fragment', () => {
        it('should create a Fragment VNode', () => {
            const vnode = jsx(Fragment, { children: ['a', 'b', 'c'] }) as VNode;

            expect(vnode.type).toBe(Fragment);
            expect(vnode.children.length).toBe(3);
        });

        it('should handle empty Fragment', () => {
            const vnode = jsx(Fragment, {}) as VNode;

            expect(vnode.type).toBe(Fragment);
            expect(vnode.children.length).toBe(0);
        });
    });

    describe('jsxs', () => {
        it('should be an alias for jsx', () => {
            const vnode1 = jsx('div', { children: 'test' }) as VNode;
            const vnode2 = jsxs('div', { children: 'test' }) as VNode;

            expect(vnode1.type).toBe(vnode2.type);
            expect(vnode1.children.length).toBe(vnode2.children.length);
        });
    });

    describe('nested elements', () => {
        it('should handle nested VNodes', () => {
            const child = jsx('span', { children: 'child' }) as VNode;
            const parent = jsx('div', { children: child }) as VNode;

            expect(parent.type).toBe('div');
            expect(parent.children.length).toBe(1);
            expect(parent.children[0].type).toBe('span');
            expect(parent.children[0].children[0].text).toBe('child');
        });
    });
});
