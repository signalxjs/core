/**
 * Focus preservation tests for the runtime-core component effect.
 *
 * The component effect in renderer.ts captures the active element before
 * patching and restores it if focus was stolen during the patch cycle:
 *
 *   const prevFocus = hostGetActiveElement ? hostGetActiveElement() : null;
 *   patch(prevSubTree, subTree, container);
 *   if (prevFocus && hostRestoreFocus && hostGetActiveElement!() !== prevFocus) {
 *       hostRestoreFocus(prevFocus);
 *   }
 *
 * These tests verify focus preservation at two levels:
 * 1. Integration: real DOM rendering via runtime-dom + happy-dom
 * 2. Unit: mock renderer with getActiveElement/restoreFocus spies
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { createRenderer } from '../src/renderer';
import { signal } from '@sigx/reactivity';
import type { VNode } from '../src/jsx-runtime';

// ---------------------------------------------------------------------------
// Integration tests (real DOM via runtime-dom + happy-dom)
// ---------------------------------------------------------------------------

describe('focus preservation (integration)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('should preserve focus on input across re-render', () => {
        const count = signal(0);

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        jsx('input', { type: 'text', id: 'my-input' }),
                        jsx('span', { children: String(count.value) }),
                    ],
                });
        });

        render(jsx(App, {}), container);

        const input = container.querySelector('#my-input') as HTMLInputElement;
        expect(input).toBeTruthy();
        input.focus();

        // Verify focus is set (happy-dom supports basic focus tracking)
        expect(document.activeElement).toBe(input);

        // Trigger a re-render by mutating the signal
        count.value = 1;

        // After re-render the span text changed but input should stay focused
        expect(container.querySelector('span')!.textContent).toBe('1');
        expect(document.activeElement).toBe(input);
    });

    it('should not interfere when no element is focused', () => {
        const count = signal(0);

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        jsx('input', { type: 'text' }),
                        jsx('span', { children: String(count.value) }),
                    ],
                });
        });

        render(jsx(App, {}), container);

        // No element focused — activeElement is body or null
        const before = document.activeElement;

        count.value = 1;

        // Re-render should complete without errors; focus unchanged
        expect(container.querySelector('span')!.textContent).toBe('1');
        expect(document.activeElement).toBe(before);
    });

    it('should preserve focus when sibling attributes change', () => {
        const active = signal(false);

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        jsx('input', {
                            type: 'text',
                            id: 'focus-input',
                            onFocus: () => { active.value = true; },
                            onBlur: () => { active.value = false; },
                        }),
                        jsx('button', {
                            className: active.value ? 'btn-active' : 'btn',
                            children: 'Action',
                        }),
                    ],
                });
        });

        render(jsx(App, {}), container);

        const input = container.querySelector('#focus-input') as HTMLInputElement;
        input.focus();

        // The focus handler mutates the signal which triggers a re-render
        // that patches the button's className. Focus should stay on input.
        expect(document.activeElement).toBe(input);
        expect(container.querySelector('button')!.getAttribute('class')).toBe(
            'btn-active',
        );
    });
});

// ---------------------------------------------------------------------------
// Unit tests (mock renderer with getActiveElement / restoreFocus)
// ---------------------------------------------------------------------------

interface MockNode {
    id: number;
    type: string;
    children: MockNode[];
    textContent: string;
    parentNode: MockNode | null;
    [key: string]: any;
}

function createMockOps() {
    let nodeIdCounter = 0;

    const createNode = (type: string): MockNode => {
        const id = ++nodeIdCounter;
        return { id, type, children: [], textContent: '', parentNode: null };
    };

    return {
        createElement: (type: string) => createNode(type),
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

describe('focus preservation (mock renderer)', () => {
    it('should call restoreFocus when active element changes during patch', () => {
        const focusedNode: MockNode = {
            id: 999, type: 'input', children: [], textContent: '', parentNode: null,
        };
        // After patch, simulate the DOM having shifted focus to a different node
        const otherNode: MockNode = {
            id: 888, type: 'button', children: [], textContent: '', parentNode: null,
        };

        let callCount = 0;
        const getActiveElement = vi.fn(() => {
            // First call (before patch): return focused node
            // Second call (after patch): return different node
            callCount++;
            return callCount <= 1 ? focusedNode : otherNode;
        });
        const restoreFocus = vi.fn();

        const mockOps = createMockOps();
        const renderer = createRenderer({
            ...mockOps,
            getActiveElement,
            restoreFocus,
        } as any);

        const container: MockNode = {
            id: 0, type: 'container', children: [], textContent: '', parentNode: null,
        };

        const count = signal(0);

        const TestComp = component(() => {
            return () => jsx('div', { children: String(count.value) });
        });

        // Mount the component (first render — no focus restoration expected)
        renderer.render(jsx(TestComp, {}), container);

        // Reset spies after mount
        getActiveElement.mockClear();
        restoreFocus.mockClear();
        callCount = 0;

        // Trigger re-render — the mock getActiveElement simulates focus shift
        count.value = 1;

        expect(getActiveElement).toHaveBeenCalled();
        expect(restoreFocus).toHaveBeenCalledWith(focusedNode);
    });

    it('should not call restoreFocus when focus element unchanged', () => {
        const focusedNode: MockNode = {
            id: 999, type: 'input', children: [], textContent: '', parentNode: null,
        };

        const getActiveElement = vi.fn(() => focusedNode);
        const restoreFocus = vi.fn();

        const mockOps = createMockOps();
        const renderer = createRenderer({
            ...mockOps,
            getActiveElement,
            restoreFocus,
        } as any);

        const container: MockNode = {
            id: 0, type: 'container', children: [], textContent: '', parentNode: null,
        };

        const count = signal(0);

        const TestComp = component(() => {
            return () => jsx('div', { children: String(count.value) });
        });

        renderer.render(jsx(TestComp, {}), container);

        getActiveElement.mockClear();
        restoreFocus.mockClear();

        // Re-render — focus stays on same node
        count.value = 1;

        expect(getActiveElement).toHaveBeenCalled();
        // Focus didn't change so restoreFocus should NOT be called
        expect(restoreFocus).not.toHaveBeenCalled();
    });

    it('should not call restoreFocus when no element is focused', () => {
        const getActiveElement = vi.fn(() => null);
        const restoreFocus = vi.fn();

        const mockOps = createMockOps();
        const renderer = createRenderer({
            ...mockOps,
            getActiveElement,
            restoreFocus,
        } as any);

        const container: MockNode = {
            id: 0, type: 'container', children: [], textContent: '', parentNode: null,
        };

        const count = signal(0);

        const TestComp = component(() => {
            return () => jsx('div', { children: String(count.value) });
        });

        renderer.render(jsx(TestComp, {}), container);

        getActiveElement.mockClear();
        restoreFocus.mockClear();

        count.value = 1;

        // No element was focused, so restoreFocus must not be called
        expect(restoreFocus).not.toHaveBeenCalled();
    });
});
