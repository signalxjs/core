/**
 * Tests for reconciler robustness with null .dom VNodes
 *
 * Verifies that reconcileChildrenArray handles VNodes with .dom = null
 * gracefully — specifically Comment placeholder VNodes that may not
 * have DOM references (e.g., after a hydration mismatch).
 *
 * Written TDD-style: should FAIL against the unguarded code,
 * PASS once null guards are added.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode, Fragment, Text, Comment, jsx } from '../src/jsx-runtime';

// Mock DOM operations — matches the pattern from reconciler.test.ts
function createMockDOMOperations() {
    const operations: string[] = [];
    let nodeIdCounter = 0;

    const createNode = (type: string) => {
        const id = ++nodeIdCounter;
        return { id, type, children: [] as any[], textContent: '', parentNode: null as any };
    };

    return {
        operations,
        createElement: (type: string) => {
            const node = createNode(type);
            operations.push(`createElement:${type}#${node.id}`);
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
            operations.push(`createComment:${text}#${node.id}`);
            return node;
        },
        insert: (child: any, parent: any, anchor: any) => {
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
        remove: (child: any) => {
            if (child.parentNode) {
                const idx = child.parentNode.children.indexOf(child);
                if (idx > -1) child.parentNode.children.splice(idx, 1);
            }
            operations.push(`remove:#${child.id}`);
        },
        patchProp: (el: any, key: string, prev: any, next: any) => {
            el[key] = next;
            operations.push(`patchProp:#${el.id}.${key}=${next}`);
        },
        setText: (node: any, text: string) => {
            node.textContent = text;
            operations.push(`setText:#${node.id}="${text}"`);
        },
        setElementText: (el: any, text: string) => {
            el.textContent = text;
            operations.push(`setElementText:#${el.id}="${text}"`);
        },
        parentNode: (node: any) => node.parentNode,
        nextSibling: (node: any) => {
            if (!node.parentNode) return null;
            const idx = node.parentNode.children.indexOf(node);
            return node.parentNode.children[idx + 1] || null;
        },
        reset: () => {
            operations.length = 0;
            nodeIdCounter = 0;
        }
    };
}

function commentVNode(): VNode {
    return { type: Comment, props: {}, key: null, children: [], dom: null };
}

describe('reconcileChildrenArray with null .dom', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: any;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps);
        container = { id: 0, type: 'container', children: [], parentNode: null };
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        mockOps.reset();
        warnSpy.mockRestore();
    });

    it('should not crash when swapping conditional children (oldStart=newEnd with Comment)', () => {
        // Initial: [ButtonA, Comment, Span]
        const v1 = jsx('div', {
            children: [
                jsx('button', { children: 'A' }),
                commentVNode(),
                jsx('span', { children: 'static' }),
            ]
        }) as VNode;
        renderer.render(v1, container);

        // After toggle: [Comment, ButtonB, Span]
        const v2 = jsx('div', {
            children: [
                commentVNode(),
                jsx('button', { children: 'B' }),
                jsx('span', { children: 'static' }),
            ]
        }) as VNode;

        expect(() => renderer.render(v2, container)).not.toThrow();
    });

    it('should not crash when Comment VNode is at end position during reconciliation', () => {
        // Initial: [Span, Comment]
        const v1 = jsx('div', {
            children: [
                jsx('span', { children: 'hello' }),
                commentVNode(),
            ]
        }) as VNode;
        renderer.render(v1, container);

        // After: [Comment, Span] (reversed)
        const v2 = jsx('div', {
            children: [
                commentVNode(),
                jsx('span', { children: 'hello' }),
            ]
        }) as VNode;

        expect(() => renderer.render(v2, container)).not.toThrow();
    });

    it('should handle rapid toggling of conditional children', () => {
        const makeVNode = (showA: boolean) => {
            return jsx('div', {
                children: [
                    showA ? jsx('button', { children: 'A' }) : commentVNode(),
                    !showA ? jsx('button', { children: 'B' }) : commentVNode(),
                    jsx('span', { children: 'static' }),
                ]
            }) as VNode;
        };

        const v1 = makeVNode(true);
        renderer.render(v1, container);

        const v2 = makeVNode(false);
        expect(() => renderer.render(v2, container)).not.toThrow();

        const v3 = makeVNode(true);
        expect(() => renderer.render(v3, container)).not.toThrow();

        const v4 = makeVNode(false);
        expect(() => renderer.render(v4, container)).not.toThrow();
    });

    it('should handle new children being added alongside Comment VNodes', () => {
        // Initial: [Comment, Comment, Span]
        const v1 = jsx('div', {
            children: [
                commentVNode(),
                commentVNode(),
                jsx('span', { children: 'only' }),
            ]
        }) as VNode;
        renderer.render(v1, container);

        // After: [ButtonA, ButtonB, Span] — all conditionals now truthy
        const v2 = jsx('div', {
            children: [
                jsx('button', { children: 'A' }),
                jsx('button', { children: 'B' }),
                jsx('span', { children: 'only' }),
            ]
        }) as VNode;

        expect(() => renderer.render(v2, container)).not.toThrow();
    });
});
