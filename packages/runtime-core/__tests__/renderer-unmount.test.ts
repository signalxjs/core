import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode, Fragment, Text, Comment, jsx } from '../src/jsx-runtime';
import type { InternalVNode } from '../src/renderer';

/**
 * Tests for the unmount() function of the renderer.
 *
 * Covers: text nodes, comment nodes, fragments, elements,
 * onElementUnmounted hook, ref cleanup (function & object),
 * component effect stop, component cleanup hook,
 * and component subtree via _subTreeRef.
 */

interface MockNode {
    id: number;
    type: string;
    children: MockNode[];
    textContent: string;
    parentNode: MockNode | null;
    [key: string]: any;
}

function createMockDOMOperations() {
    const operations: string[] = [];
    let nodeIdCounter = 0;

    const patchPropCalls: { el: MockNode; key: string; prevValue: any; nextValue: any; isSVG?: boolean }[] = [];
    const patchDirectiveCalls: { el: MockNode; name: string; prevValue: any; nextValue: any; appContext: any }[] = [];
    const elementMountedCalls: MockNode[] = [];
    const elementUnmountedCalls: MockNode[] = [];
    const createElementCalls: { type: string; isSVG?: boolean }[] = [];

    const createNode = (type: string): MockNode => {
        const id = ++nodeIdCounter;
        return { id, type, children: [], textContent: '', parentNode: null };
    };

    return {
        operations,
        patchPropCalls,
        patchDirectiveCalls,
        elementMountedCalls,
        elementUnmountedCalls,
        createElementCalls,

        createElement: (type: string, isSVG?: boolean) => {
            const node = createNode(type);
            createElementCalls.push({ type, isSVG });
            operations.push(`createElement:${type}#${node.id}${isSVG ? ':svg' : ''}`);
            return node;
        },
        createText: (text: string) => {
            const node = createNode('TEXT');
            node.textContent = text;
            operations.push(`createText:"${text}"#${node.id}`);
            return node;
        },
        createComment: (text: string) => {
            const node = createNode('COMMENT');
            node.textContent = text;
            operations.push(`createComment:"${text}"#${node.id}`);
            return node;
        },
        insert: (child: MockNode, parent: MockNode, anchor?: MockNode | null) => {
            if (anchor) {
                const idx = parent.children.indexOf(anchor);
                parent.children.splice(idx, 0, child);
                operations.push(`insert:#${child.id}->parent#${parent.id}@anchor#${anchor.id}`);
            } else {
                parent.children.push(child);
                operations.push(`insert:#${child.id}->parent#${parent.id}`);
            }
            child.parentNode = parent;
        },
        remove: (child: MockNode) => {
            if (child.parentNode) {
                const idx = child.parentNode.children.indexOf(child);
                if (idx > -1) child.parentNode.children.splice(idx, 1);
            }
            operations.push(`remove:#${child.id}`);
        },
        patchProp: (el: MockNode, key: string, prev: any, next: any, isSVG?: boolean) => {
            el[key] = next;
            patchPropCalls.push({ el, key, prevValue: prev, nextValue: next, isSVG });
            operations.push(`patchProp:#${el.id}.${key}=${next}`);
        },
        setText: (node: MockNode, text: string) => {
            node.textContent = text;
            operations.push(`setText:#${node.id}="${text}"`);
        },
        setElementText: (el: MockNode, text: string) => {
            el.textContent = text;
            operations.push(`setElementText:#${el.id}="${text}"`);
        },
        parentNode: (node: MockNode) => node.parentNode,
        nextSibling: (node: MockNode) => {
            if (!node.parentNode) return null;
            const idx = node.parentNode.children.indexOf(node);
            return node.parentNode.children[idx + 1] || null;
        },
        patchDirective: (el: MockNode, name: string, prevValue: any, nextValue: any, appContext: any) => {
            patchDirectiveCalls.push({ el, name, prevValue, nextValue, appContext });
            operations.push(`patchDirective:#${el.id}.${name}`);
        },
        onElementMounted: (el: MockNode) => {
            elementMountedCalls.push(el);
            operations.push(`onElementMounted:#${el.id}`);
        },
        onElementUnmounted: (el: MockNode) => {
            elementUnmountedCalls.push(el);
            operations.push(`onElementUnmounted:#${el.id}`);
        },
        reset: () => {
            operations.length = 0;
            patchPropCalls.length = 0;
            patchDirectiveCalls.length = 0;
            elementMountedCalls.length = 0;
            elementUnmountedCalls.length = 0;
            createElementCalls.length = 0;
            nodeIdCounter = 0;
        }
    };
}

/** Create a fake component type that passes the `isComponent` check. */
function fakeComponent() {}
(fakeComponent as any).__setup = () => {};

describe('Renderer - unmount()', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
    });

    // ── Text node ───────────────────────────────────────────────────────

    it('should unmount a text node by removing its DOM', () => {
        const vnode: VNode = {
            type: Text,
            props: {},
            key: null,
            children: [],
            dom: null,
            text: 'hello'
        };

        renderer.mount(vnode, container);
        expect(container.children).toHaveLength(1);

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        expect(mockOps.operations).toContain(`remove:#${(vnode.dom as any).id}`);
    });

    // ── Comment node ────────────────────────────────────────────────────

    it('should unmount a comment node by removing its DOM', () => {
        const vnode: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        renderer.mount(vnode, container);
        const domId = (vnode.dom as any).id;
        expect(container.children).toHaveLength(1);

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        expect(mockOps.operations).toEqual([`remove:#${domId}`]);
    });

    // ── Fragment ────────────────────────────────────────────────────────

    it('should unmount a fragment by unmounting all children and removing anchor', () => {
        const vnode = jsx(Fragment, {
            children: [
                jsx('span', { children: 'A' }),
                jsx('span', { children: 'B' })
            ]
        }) as VNode;

        renderer.mount(vnode, container);
        // container has: span, span, anchor comment
        const anchorId = (vnode.dom as any).id;
        const childCount = container.children.length;
        expect(childCount).toBeGreaterThanOrEqual(3);

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        // Should have remove ops for children and the anchor
        const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removeOps.length).toBeGreaterThanOrEqual(3); // 2 spans (+ their text nodes) + anchor
        // Anchor itself should be removed
        expect(mockOps.operations).toContain(`remove:#${anchorId}`);
    });

    // ── Element ─────────────────────────────────────────────────────────

    it('should unmount an element by removing DOM and unmounting children', () => {
        const vnode = jsx('ul', {
            children: [
                jsx('li', { children: 'One' }),
                jsx('li', { children: 'Two' })
            ]
        }) as VNode;

        renderer.mount(vnode, container);
        const ulId = (vnode.dom as any).id;
        expect(container.children).toHaveLength(1);

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        // Children (li + their text nodes) should be unmounted, then the ul removed
        const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
        // At minimum: 2 li text nodes + 2 li elements + 1 ul = 5
        expect(removeOps.length).toBeGreaterThanOrEqual(5);
        // The ul itself must be removed
        expect(mockOps.operations).toContain(`remove:#${ulId}`);
    });

    // ── onElementUnmounted hook ─────────────────────────────────────────

    it('should call onElementUnmounted before removing element DOM', () => {
        const vnode = jsx('div', {}) as VNode;

        renderer.mount(vnode, container);
        const domId = (vnode.dom as any).id;

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        // onElementUnmounted should have been called
        expect(mockOps.elementUnmountedCalls).toHaveLength(1);
        expect(mockOps.elementUnmountedCalls[0]).toBe(vnode.dom);

        // onElementUnmounted should come before the remove for this element
        const unmountedIdx = mockOps.operations.indexOf(`onElementUnmounted:#${domId}`);
        const removeIdx = mockOps.operations.indexOf(`remove:#${domId}`);
        expect(unmountedIdx).toBeGreaterThanOrEqual(0);
        expect(removeIdx).toBeGreaterThan(unmountedIdx);
    });

    // ── Function ref cleanup ────────────────────────────────────────────

    it('should clean function ref with null on element unmount', () => {
        const refFn = vi.fn();
        const vnode = jsx('div', { ref: refFn }) as VNode;

        renderer.mount(vnode, container);
        expect(refFn).toHaveBeenCalledWith(vnode.dom);
        refFn.mockClear();

        renderer.unmount(vnode, container);

        expect(refFn).toHaveBeenCalledTimes(1);
        expect(refFn).toHaveBeenCalledWith(null);
    });

    // ── Object ref cleanup ──────────────────────────────────────────────

    it('should clean object ref.current on element unmount', () => {
        const refObj = { current: null as any };
        const vnode = jsx('div', { ref: refObj }) as VNode;

        renderer.mount(vnode, container);
        expect(refObj.current).toBe(vnode.dom);

        renderer.unmount(vnode, container);

        expect(refObj.current).toBeNull();
    });

    // ── Component: effect stop ──────────────────────────────────────────

    it('should stop component effect on unmount', () => {
        // Build a component vnode with a mock subtree manually
        const subTreeDom: MockNode = { id: 900, type: 'COMMENT', children: [], textContent: '', parentNode: container };
        container.children.push(subTreeDom);

        const subTree: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: subTreeDom
        };

        const anchorDom: MockNode = { id: 901, type: 'COMMENT', children: [], textContent: '', parentNode: container };
        container.children.push(anchorDom);

        const stopFn = vi.fn();
        const vnode: VNode = {
            type: fakeComponent as any,
            props: {},
            key: null,
            children: [],
            dom: anchorDom
        };
        const internal = vnode as InternalVNode;
        internal._effect = { stop: stopFn } as any;
        internal._subTree = subTree;

        renderer.unmount(vnode, container);

        expect(stopFn).toHaveBeenCalledTimes(1);
    });

    // ── Component: cleanup hook ─────────────────────────────────────────

    it('should run component cleanup hook on unmount', () => {
        const subTreeDom: MockNode = { id: 900, type: 'COMMENT', children: [], textContent: '', parentNode: container };
        container.children.push(subTreeDom);

        const subTree: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: subTreeDom
        };

        const anchorDom: MockNode = { id: 901, type: 'COMMENT', children: [], textContent: '', parentNode: container };
        container.children.push(anchorDom);

        const cleanupFn = vi.fn();
        const vnode: VNode = {
            type: fakeComponent as any,
            props: {},
            key: null,
            children: [],
            dom: anchorDom,
            cleanup: cleanupFn
        };
        const internal = vnode as InternalVNode;
        internal._effect = { stop: vi.fn() } as any;
        internal._subTree = subTree;

        renderer.unmount(vnode, container);

        expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    // ── Component: subtree via _subTreeRef.current ──────────────────────

    it('should unmount component subtree via _subTreeRef.current', () => {
        // _subTree is the stale subtree, _subTreeRef.current is the live one
        const staleDom: MockNode = { id: 800, type: 'COMMENT', children: [], textContent: 'stale', parentNode: null };
        const staleSubTree: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: staleDom
        };

        const liveDom: MockNode = { id: 801, type: 'COMMENT', children: [], textContent: 'live', parentNode: container };
        container.children.push(liveDom);
        const liveSubTree: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: liveDom
        };

        const anchorDom: MockNode = { id: 802, type: 'COMMENT', children: [], textContent: '', parentNode: container };
        container.children.push(anchorDom);

        const vnode: VNode = {
            type: fakeComponent as any,
            props: {},
            key: null,
            children: [],
            dom: anchorDom
        };
        const internal = vnode as InternalVNode;
        internal._effect = { stop: vi.fn() } as any;
        internal._subTree = staleSubTree;
        internal._subTreeRef = { current: liveSubTree };

        mockOps.operations.length = 0;
        renderer.unmount(vnode, container);

        // The live subtree's dom should be removed (id 801), not the stale one (id 800)
        expect(mockOps.operations).toContain(`remove:#${liveDom.id}`);
        expect(mockOps.operations).not.toContain(`remove:#${staleDom.id}`);
    });
});
