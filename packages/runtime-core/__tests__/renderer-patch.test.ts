import { describe, it, expect, beforeEach } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode, Fragment, Text, Comment, jsx } from '../src/jsx-runtime';

/**
 * Tests for the patch() function of the renderer.
 *
 * Covers: identity check, type mismatch replacement, text nodes,
 * comment nodes, fragments, element prop diffing, use:* directives,
 * SVG context propagation, and hydration guards.
 *
 * Component patching is tested separately.
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

/** Helper: mount a VNode and return the mock ops (resets tracked ops after mount). */
function mountAndReset(
    renderer: ReturnType<typeof createRenderer>,
    mockOps: ReturnType<typeof createMockDOMOperations>,
    vnode: VNode,
    container: MockNode,
) {
    renderer.mount(vnode, container);
    mockOps.operations.length = 0;
    mockOps.patchPropCalls.length = 0;
    mockOps.patchDirectiveCalls.length = 0;
    mockOps.elementMountedCalls.length = 0;
    mockOps.createElementCalls.length = 0;
}

describe('Renderer - patch()', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
    });

    // ── Identity & Type mismatch ──────────────────────────────────────

    describe('identity & type mismatch', () => {
        it('should no-op when patching same VNode instance', () => {
            const vnode = jsx('div', {}) as VNode;
            mountAndReset(renderer, mockOps, vnode, container);

            renderer.patch(vnode, vnode, container);

            expect(mockOps.operations).toHaveLength(0);
        });

        it('should replace completely when types differ', () => {
            const oldVNode = jsx('div', { children: 'old' }) as VNode;
            mountAndReset(renderer, mockOps, oldVNode, container);

            const newVNode = jsx('span', { children: 'new' }) as VNode;
            renderer.patch(oldVNode, newVNode, container);

            // Old div should be removed
            expect(mockOps.operations.some(op => op.startsWith('remove:'))).toBe(true);
            // New span should be created and inserted
            expect(mockOps.operations.some(op => op.startsWith('createElement:span'))).toBe(true);
            expect(newVNode.dom).not.toBeNull();
            expect(newVNode.dom.type).toBe('span');
        });

        it('should insert new node at correct position on type mismatch', () => {
            // Mount two siblings: div, p
            const div = jsx('div', {}) as VNode;
            const p = jsx('p', {}) as VNode;
            renderer.mount(div, container);
            renderer.mount(p, container);
            // container.children: [div.dom, p.dom]
            mockOps.operations.length = 0;

            // Replace div with span — should use nextSibling (p.dom) as anchor
            const span = jsx('span', {}) as VNode;
            renderer.patch(div, span, container);

            // The insert should reference p's dom node as anchor
            const insertOps = mockOps.operations.filter(op => op.startsWith('insert:'));
            expect(insertOps.length).toBeGreaterThan(0);
            // span should appear before p in the container
            const spanIdx = container.children.indexOf(span.dom);
            const pIdx = container.children.indexOf(p.dom);
            expect(spanIdx).toBeLessThan(pIdx);
        });
    });

    // ── Text nodes ────────────────────────────────────────────────────

    describe('text nodes', () => {
        it('should update text content when text changes', () => {
            const oldText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'hello' };
            mountAndReset(renderer, mockOps, oldText, container);

            const newText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'world' };
            renderer.patch(oldText, newText, container);

            expect(newText.dom).toBe(oldText.dom);
            expect(mockOps.operations.some(op => op.startsWith('setText:') && op.includes('"world"'))).toBe(true);
        });

        it('should skip text update when content unchanged', () => {
            const oldText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'same' };
            mountAndReset(renderer, mockOps, oldText, container);

            const newText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'same' };
            renderer.patch(oldText, newText, container);

            expect(newText.dom).toBe(oldText.dom);
            expect(mockOps.operations.some(op => op.startsWith('setText:'))).toBe(false);
        });

        it('should create fresh text node when old DOM is null', () => {
            // Simulate hydration mismatch: old text vnode with dom=null
            const oldText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'old' };
            // Do NOT mount — leave dom null
            const newText: VNode = { type: Text, props: {}, key: null, children: [], dom: null, text: 'fresh' };

            renderer.patch(oldText, newText, container);

            expect(newText.dom).not.toBeNull();
            expect(newText.dom.textContent).toBe('fresh');
            expect(mockOps.operations.some(op => op.startsWith('createText:') && op.includes('"fresh"'))).toBe(true);
        });
    });

    // ── Comment nodes ─────────────────────────────────────────────────

    describe('comment nodes', () => {
        it('should transfer DOM reference on comment patch', () => {
            const oldComment: VNode = { type: Comment, props: {}, key: null, children: [], dom: null };
            mountAndReset(renderer, mockOps, oldComment, container);
            const savedDom = oldComment.dom;

            const newComment: VNode = { type: Comment, props: {}, key: null, children: [], dom: null };
            renderer.patch(oldComment, newComment, container);

            expect(newComment.dom).toBe(savedDom);
            // No DOM mutations needed
            expect(mockOps.operations).toHaveLength(0);
        });
    });

    // ── Fragment ──────────────────────────────────────────────────────

    describe('fragment', () => {
        it('should delegate fragment patch to patchChildren', () => {
            const oldFrag = jsx(Fragment, {
                children: [jsx('span', { key: 'a', children: 'A' })]
            }) as VNode;
            mountAndReset(renderer, mockOps, oldFrag, container);

            const newFrag = jsx(Fragment, {
                children: [
                    jsx('span', { key: 'a', children: 'A' }),
                    jsx('span', { key: 'b', children: 'B' })
                ]
            }) as VNode;
            renderer.patch(oldFrag, newFrag, container);

            // A second span should have been created for child 'b'
            expect(mockOps.operations.some(op => op.startsWith('createElement:span'))).toBe(true);
        });
    });

    // ── Element props ─────────────────────────────────────────────────

    describe('element props', () => {
        it('should add new props on element patch', () => {
            const oldEl = jsx('div', {}) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', { id: 'new-id' }) as VNode;
            renderer.patch(oldEl, newEl, container);

            const addCall = mockOps.patchPropCalls.find(c => c.key === 'id');
            expect(addCall).toBeDefined();
            expect(addCall!.prevValue).toBeUndefined();
            expect(addCall!.nextValue).toBe('new-id');
        });

        it('should remove old props not in new VNode', () => {
            const oldEl = jsx('div', { id: 'old-id', className: 'old' }) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', {}) as VNode;
            renderer.patch(oldEl, newEl, container);

            const removeId = mockOps.patchPropCalls.find(c => c.key === 'id');
            expect(removeId).toBeDefined();
            expect(removeId!.prevValue).toBe('old-id');
            expect(removeId!.nextValue).toBeNull();

            const removeClass = mockOps.patchPropCalls.find(c => c.key === 'className');
            expect(removeClass).toBeDefined();
            expect(removeClass!.prevValue).toBe('old');
            expect(removeClass!.nextValue).toBeNull();
        });

        it('should update changed props', () => {
            const oldEl = jsx('div', { id: 'before' }) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', { id: 'after' }) as VNode;
            renderer.patch(oldEl, newEl, container);

            const call = mockOps.patchPropCalls.find(c => c.key === 'id');
            expect(call).toBeDefined();
            expect(call!.prevValue).toBe('before');
            expect(call!.nextValue).toBe('after');
        });

        it('should skip unchanged props (identity check)', () => {
            const sharedHandler = () => {};
            const oldEl = jsx('div', { id: 'same', onClick: sharedHandler }) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', { id: 'same', onClick: sharedHandler }) as VNode;
            renderer.patch(oldEl, newEl, container);

            // No patchProp calls — both id and onClick have identical values
            expect(mockOps.patchPropCalls).toHaveLength(0);
        });

        it('should handle use:* directive update via patchDirective', () => {
            const oldVal = { x: 1 };
            const newVal = { x: 2 };
            const oldEl = jsx('div', { 'use:tooltip': oldVal }) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', { 'use:tooltip': newVal }) as VNode;
            renderer.patch(oldEl, newEl, container);

            expect(mockOps.patchDirectiveCalls).toHaveLength(1);
            const call = mockOps.patchDirectiveCalls[0];
            expect(call.name).toBe('tooltip');
            expect(call.prevValue).toBe(oldVal);
            expect(call.nextValue).toBe(newVal);
            // Should NOT appear as regular patchProp
            expect(mockOps.patchPropCalls.find(c => c.key === 'use:tooltip')).toBeUndefined();
        });

        it('should handle use:* directive removal via patchDirective', () => {
            const dirVal = { active: true };
            const oldEl = jsx('div', { 'use:myDir': dirVal }) as VNode;
            mountAndReset(renderer, mockOps, oldEl, container);

            const newEl = jsx('div', {}) as VNode;
            renderer.patch(oldEl, newEl, container);

            expect(mockOps.patchDirectiveCalls).toHaveLength(1);
            const call = mockOps.patchDirectiveCalls[0];
            expect(call.name).toBe('myDir');
            expect(call.prevValue).toBe(dirVal);
            expect(call.nextValue).toBeNull();
        });
    });

    // ── Element edge cases ────────────────────────────────────────────

    describe('element edge cases', () => {
        it('should mount fresh element when old DOM is null', () => {
            // Simulate hydration scenario: old element vnode with dom=null
            const oldEl: VNode = { type: 'div', props: { id: 'old' }, key: null, children: [], dom: null };
            // Do NOT mount — leave dom null
            const newEl: VNode = { type: 'div', props: { id: 'new' }, key: null, children: [], dom: null };

            renderer.patch(oldEl, newEl, container);

            // Should have fallen through to mount()
            expect(newEl.dom).not.toBeNull();
            expect(newEl.dom.type).toBe('div');
            expect(mockOps.operations.some(op => op.startsWith('createElement:div'))).toBe(true);
        });

        it('should pass SVG context to patchChildren for SVG elements', () => {
            // Mount an svg with a rect child
            const oldSvg = jsx('svg', {
                children: [jsx('rect', { key: 'r', width: '10' })]
            }) as VNode;
            mountAndReset(renderer, mockOps, oldSvg, container);

            // Patch: add a second SVG child
            const newSvg = jsx('svg', {
                children: [
                    jsx('rect', { key: 'r', width: '20' }),
                    jsx('circle', { key: 'c', cx: '5' })
                ]
            }) as VNode;
            renderer.patch(oldSvg, newSvg, container);

            // The new circle should be created with SVG flag
            const circleCall = mockOps.createElementCalls.find(c => c.type === 'circle');
            expect(circleCall).toBeDefined();
            expect(circleCall!.isSVG).toBe(true);
        });
    });
});
