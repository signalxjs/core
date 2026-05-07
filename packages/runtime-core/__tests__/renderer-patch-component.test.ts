import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode } from '../src/jsx-runtime';
import { createModel } from '../src/model';

/**
 * Tests for same-type component patching in the renderer.
 *
 * Component patching is detected by `if (oldInternal._effect)` —
 * it transfers internal state from old to new VNode and updates
 * reactive props/slots in-place without mount/unmount.
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
    let nodeIdCounter = 0;

    const createNode = (type: string): MockNode => {
        const id = ++nodeIdCounter;
        return { id, type, children: [], textContent: '', parentNode: null };
    };

    return {
        createElement: (type: string, _isSVG?: boolean) => createNode(type),
        createText: (text: string) => {
            const node = createNode('TEXT');
            node.textContent = text;
            return node;
        },
        createComment: (text: string) => {
            const node = createNode('COMMENT');
            node.textContent = text;
            return node;
        },
        insert: (child: MockNode, parent: MockNode, anchor?: MockNode | null) => {
            if (anchor) {
                const idx = parent.children.indexOf(anchor);
                parent.children.splice(idx, 0, child);
            } else {
                parent.children.push(child);
            }
            child.parentNode = parent;
        },
        remove: (child: MockNode) => {
            if (child.parentNode) {
                const idx = child.parentNode.children.indexOf(child);
                if (idx > -1) child.parentNode.children.splice(idx, 1);
            }
        },
        patchProp: (el: MockNode, key: string, _prev: any, next: any) => {
            el[key] = next;
        },
        setText: (node: MockNode, text: string) => {
            node.textContent = text;
        },
        setElementText: (el: MockNode, text: string) => {
            el.textContent = text;
        },
        parentNode: (node: MockNode) => node.parentNode,
        nextSibling: (node: MockNode) => {
            if (!node.parentNode) return null;
            const idx = node.parentNode.children.indexOf(node);
            return node.parentNode.children[idx + 1] || null;
        },
        patchDirective: () => {},
        onElementMounted: () => {},
    };
}

/** Shared component function identity so isSameVNode returns true */
const MyComponent = () => {};

function makeComponentVNode(props: Record<string, any> = {}): VNode {
    return {
        type: MyComponent,
        props,
        key: null,
        children: [],
        dom: null,
    };
}

function makeSlotsRef(overrides: Record<string, any> = {}) {
    return {
        default: () => [],
        _children: null as any,
        _slotsFromProps: {} as Record<string, any>,
        _version: { v: 0 },
        _isPatching: false,
        ...overrides,
    };
}

describe('Renderer - patch() same-type component', () => {
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;

    beforeEach(() => {
        const mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
    });

    it('should transfer _effect from old to new VNode', () => {
        const mockEffect = { stop: vi.fn() } as any;
        const oldVNode = makeComponentVNode({ title: 'old' }) as any;
        oldVNode._effect = mockEffect;
        oldVNode._componentProps = { title: 'old' };
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 99 };

        const newVNode = makeComponentVNode({ title: 'new' }) as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(newVNode._effect).toBe(mockEffect);
    });

    it('should transfer _subTree and _subTreeRef', () => {
        const subTree = makeComponentVNode();
        const subTreeRef = { current: subTree };
        const oldVNode = makeComponentVNode() as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._subTree = subTree;
        oldVNode._subTreeRef = subTreeRef;
        oldVNode._componentProps = {};
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode() as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(newVNode._subTree).toBe(subTree);
        expect(newVNode._subTreeRef).toBe(subTreeRef);
    });

    it('should transfer _slots and _componentProps', () => {
        const slots = makeSlotsRef();
        const componentProps = { count: 1 };
        const oldVNode = makeComponentVNode() as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._slots = slots;
        oldVNode._componentProps = componentProps;
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode() as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(newVNode._slots).toBe(slots);
        expect(newVNode._componentProps).toBe(componentProps);
    });

    it('should update changed props on reactive signal', () => {
        const componentProps: Record<string, any> = { title: 'old', count: 1 };
        const oldVNode = makeComponentVNode({ title: 'old', count: 1 }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode({ title: 'new', count: 2 }) as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(componentProps.title).toBe('new');
        expect(componentProps.count).toBe(2);
    });

    it('should skip unchanged props (identity check)', () => {
        const sameObj = { nested: true };
        const componentProps: Record<string, any> = { data: sameObj };
        const oldVNode = makeComponentVNode({ data: sameObj }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode({ data: sameObj }) as any;

        // Spy on property assignment via a setter
        const propSpy = vi.fn();
        const proxy = new Proxy(componentProps, {
            set(target, key, value) {
                propSpy(key, value);
                target[key as string] = value;
                return true;
            },
        });
        oldVNode._componentProps = proxy;

        renderer.patch(oldVNode, newVNode, container as any);

        // 'data' should NOT be reassigned because identity is the same
        const dataCalls = propSpy.mock.calls.filter(([k]: any) => k === 'data');
        expect(dataCalls).toHaveLength(0);
    });

    it('should remove deleted props', () => {
        const componentProps: Record<string, any> = { title: 'hello', removed: true };
        const oldVNode = makeComponentVNode({ title: 'hello', removed: true }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        // New VNode only has 'title', not 'removed'
        const newVNode = makeComponentVNode({ title: 'hello' }) as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(componentProps.title).toBe('hello');
        expect('removed' in componentProps).toBe(false);
    });

    it('should update Model binding when obj/key changes', () => {
        const obj1 = { name: 'Alice' };
        const obj2 = { name: 'Bob' };
        const handler1 = (v: any) => { obj1.name = v; };
        const handler2 = (v: any) => { obj2.name = v; };

        const oldModel = createModel<string>([obj1, 'name'], handler1);
        const newModel = createModel<string>([obj2, 'name'], handler2);

        const componentProps: Record<string, any> = { modelValue: oldModel };
        const oldVNode = makeComponentVNode({ $models: { modelValue: oldModel } }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode({ $models: { modelValue: newModel } }) as any;

        renderer.patch(oldVNode, newVNode, container as any);

        expect(componentProps.modelValue).toBe(newModel);
    });

    it('should skip Model update when binding is same', () => {
        const obj = { name: 'Alice' };
        const handler = (v: any) => { obj.name = v; };

        const oldModel = createModel<string>([obj, 'name'], handler);
        const newModel = createModel<string>([obj, 'name'], handler);

        const componentProps: Record<string, any> = { modelValue: oldModel };
        const oldVNode = makeComponentVNode({ $models: { modelValue: oldModel } }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = makeSlotsRef();
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode({ $models: { modelValue: newModel } }) as any;

        renderer.patch(oldVNode, newVNode, container as any);

        // Should still be the old model since binding (obj + key) is the same
        expect(componentProps.modelValue).toBe(oldModel);
    });

    it('should bump slots version to trigger re-render', () => {
        const slots = makeSlotsRef({ _children: 'old children', _slotsFromProps: {} });
        const componentProps: Record<string, any> = {};
        const oldVNode = makeComponentVNode({ children: 'old children' }) as any;
        oldVNode._effect = { stop: vi.fn() };
        oldVNode._componentProps = componentProps;
        oldVNode._slots = slots;
        oldVNode.dom = { id: 1 };

        const newVNode = makeComponentVNode({ children: 'new children', slots: { header: () => 'h' } }) as any;

        expect(slots._version.v).toBe(0);
        expect(slots._isPatching).toBe(false);

        renderer.patch(oldVNode, newVNode, container as any);

        expect(slots._version.v).toBe(1);
        expect(slots._children).toBe('new children');
        expect(slots._slotsFromProps).toEqual({ header: expect.any(Function) });
        // _isPatching should be reset after patch
        expect(slots._isPatching).toBe(false);
    });
});
