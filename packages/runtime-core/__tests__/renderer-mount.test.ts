import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode, Fragment, Text, Comment, jsx } from '../src/jsx-runtime';

/**
 * Tests for the mount() function of the SignalX renderer.
 *
 * Covers: text nodes, comment nodes, fragments, element props,
 * ref handling, SVG context propagation, use:* directives,
 * onElementMounted hook, and null/undefined/boolean guard.
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
        reset: () => {
            operations.length = 0;
            patchPropCalls.length = 0;
            patchDirectiveCalls.length = 0;
            elementMountedCalls.length = 0;
            createElementCalls.length = 0;
            nodeIdCounter = 0;
        }
    };
}

describe('Renderer - mount()', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
    });

    it('should mount a text node', () => {
        const vnode: VNode = {
            type: Text,
            props: {},
            key: null,
            children: [],
            dom: null,
            text: 'hello'
        };

        renderer.mount(vnode, container);

        expect(vnode.dom).not.toBeNull();
        expect(vnode.dom.type).toBe('TEXT');
        expect(vnode.dom.textContent).toBe('hello');
        // Text node should be inserted into container
        expect(container.children).toHaveLength(1);
        expect(container.children[0]).toBe(vnode.dom);
        expect(mockOps.operations.some(op => op.startsWith('createText:'))).toBe(true);
    });

    it('should mount a comment node', () => {
        const vnode: VNode = {
            type: Comment,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        renderer.mount(vnode, container);

        expect(vnode.dom).not.toBeNull();
        expect(vnode.dom.type).toBe('COMMENT');
        expect(container.children).toHaveLength(1);
        expect(container.children[0]).toBe(vnode.dom);
    });

    it('should mount a fragment with children', () => {
        const vnode = jsx(Fragment, {
            children: [
                jsx('span', { children: 'A' }),
                jsx('span', { children: 'B' })
            ]
        }) as VNode;

        renderer.mount(vnode, container);

        // Fragment creates an anchor comment + mounts each child before it
        expect(vnode.dom).not.toBeNull();
        expect(vnode.dom.type).toBe('COMMENT'); // anchor
        // Container should have: child1, child2, anchor
        // Each span child has a text child mounted inside the span
        const createOps = mockOps.operations.filter(op => op.startsWith('createElement:span'));
        expect(createOps).toHaveLength(2);
    });

    it('should mount an empty fragment', () => {
        const vnode = jsx(Fragment, { children: [] }) as VNode;

        renderer.mount(vnode, container);

        // Should just create the anchor comment, no crash
        expect(vnode.dom).not.toBeNull();
        expect(vnode.dom.type).toBe('COMMENT');
        // Only the anchor comment in operations
        const commentOps = mockOps.operations.filter(op => op.startsWith('createComment:'));
        expect(commentOps).toHaveLength(1);
    });

    it('should mount an element with props', () => {
        const vnode = jsx('div', {
            id: 'app',
            className: 'root',
            'data-x': '42',
            children: null,
            key: 'mykey',
            ref: undefined
        }) as VNode;

        renderer.mount(vnode, container);

        // patchProp should be called for id, className, data-x but NOT children, key, ref
        const propKeys = mockOps.patchPropCalls.map(c => c.key);
        expect(propKeys).toContain('id');
        expect(propKeys).toContain('className');
        expect(propKeys).toContain('data-x');
        expect(propKeys).not.toContain('children');
        expect(propKeys).not.toContain('key');
        expect(propKeys).not.toContain('ref');
    });

    it('should mount an element and insert children', () => {
        const vnode = jsx('ul', {
            children: [
                jsx('li', { children: 'One' }),
                jsx('li', { children: 'Two' })
            ]
        }) as VNode;

        renderer.mount(vnode, container);

        // The ul element should be created
        expect(vnode.dom).not.toBeNull();
        expect(vnode.dom.type).toBe('ul');
        // Two li children should be created and inserted into the ul
        const liOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
        expect(liOps).toHaveLength(2);
        // Li elements are children of the ul node
        expect(vnode.dom.children.length).toBeGreaterThanOrEqual(2);
    });

    it('should call function ref with element on mount', () => {
        const refFn = vi.fn();
        const vnode = jsx('div', { ref: refFn }) as VNode;

        renderer.mount(vnode, container);

        expect(refFn).toHaveBeenCalledTimes(1);
        expect(refFn).toHaveBeenCalledWith(vnode.dom);
    });

    it('should set object ref.current on mount', () => {
        const refObj = { current: null as any };
        const vnode = jsx('div', { ref: refObj }) as VNode;

        renderer.mount(vnode, container);

        expect(refObj.current).toBe(vnode.dom);
    });

    it('should call hostPatchDirective for use:* props', () => {
        const directiveValue = { arg: 'test' };
        const vnode = jsx('div', { 'use:myDir': directiveValue }) as VNode;

        renderer.mount(vnode, container);

        expect(mockOps.patchDirectiveCalls).toHaveLength(1);
        const call = mockOps.patchDirectiveCalls[0];
        expect(call.name).toBe('myDir');
        expect(call.prevValue).toBeNull();
        expect(call.nextValue).toBe(directiveValue);
        // use:myDir should NOT appear as a regular patchProp call
        const propKeys = mockOps.patchPropCalls.map(c => c.key);
        expect(propKeys).not.toContain('use:myDir');
    });

    it('should create SVG elements with isSVG flag', () => {
        const vnode = jsx('svg', {}) as VNode;

        renderer.mount(vnode, container);

        expect(mockOps.createElementCalls).toHaveLength(1);
        expect(mockOps.createElementCalls[0].type).toBe('svg');
        expect(mockOps.createElementCalls[0].isSVG).toBe(true);
    });

    it('should propagate SVG context to children', () => {
        const vnode = jsx('svg', {
            children: jsx('rect', {})
        }) as VNode;

        renderer.mount(vnode, container);

        // svg itself
        const svgCall = mockOps.createElementCalls.find(c => c.type === 'svg');
        expect(svgCall?.isSVG).toBe(true);
        // rect inside svg should also have isSVG=true
        const rectCall = mockOps.createElementCalls.find(c => c.type === 'rect');
        expect(rectCall?.isSVG).toBe(true);
    });

    it('should reset SVG context inside foreignObject', () => {
        const vnode = jsx('svg', {
            children: jsx('foreignObject', {
                children: jsx('div', {})
            })
        }) as VNode;

        renderer.mount(vnode, container);

        const svgCall = mockOps.createElementCalls.find(c => c.type === 'svg');
        expect(svgCall?.isSVG).toBe(true);
        // foreignObject itself: parentIsSVG=true, tag!=='foreignObject' is false → isSVG=false
        const foCall = mockOps.createElementCalls.find(c => c.type === 'foreignObject');
        expect(foCall?.isSVG).toBe(false);
        // div inside foreignObject should have isSVG=false
        const divCall = mockOps.createElementCalls.find(c => c.type === 'div');
        expect(divCall?.isSVG).toBe(false);
    });

    it('should no-op for null/undefined/boolean vnodes', () => {
        const initialOpsCount = mockOps.operations.length;

        renderer.mount(null as any, container);
        renderer.mount(undefined as any, container);
        renderer.mount(true as any, container);
        renderer.mount(false as any, container);

        // No operations should have been performed
        expect(mockOps.operations.length).toBe(initialOpsCount);
        expect(container.children).toHaveLength(0);
    });

    it('should call onElementMounted after element insertion', () => {
        const vnode = jsx('div', { id: 'test' }) as VNode;

        renderer.mount(vnode, container);

        expect(mockOps.elementMountedCalls).toHaveLength(1);
        expect(mockOps.elementMountedCalls[0]).toBe(vnode.dom);
        // onElementMounted should be the last operation (after insert)
        const insertIdx = mockOps.operations.findIndex(op => op.includes('insert:'));
        const mountedIdx = mockOps.operations.findIndex(op => op.includes('onElementMounted:'));
        expect(mountedIdx).toBeGreaterThan(insertIdx);
    });
});
