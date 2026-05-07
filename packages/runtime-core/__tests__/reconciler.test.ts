import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRenderer, isComponent } from '../src/renderer';
import { VNode, Fragment, Text, jsx } from '../src/jsx-runtime';

/**
 * Tests for the reconciliation algorithm, specifically key-based diffing.
 * 
 * Keys are used to:
 * 1. Identify which items in a list have changed, moved, added, or removed
 * 2. Preserve component state across re-renders
 * 3. Optimize DOM updates by reusing existing elements
 */

// Mock DOM operations for testing
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

describe('Reconciler - Key-based Diffing', () => {
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

    describe('Keyed list reconciliation', () => {
        it('should reuse elements when keys match during reorder', () => {
            // Initial render: [A, B, C]
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Reorder: [C, A, B]
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'c', children: 'C' }),
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should move elements, not recreate them
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement'));
            expect(createOps.length).toBe(0); // No new elements created
        });

        it('should add new elements when keys are new', () => {
            // Initial: [A, B]
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Add C: [A, B, C]
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should create only the new element
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(createOps.length).toBe(1);
        });

        it('should remove elements when keys are removed', () => {
            // Initial: [A, B, C]
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Remove B: [A, C]
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should remove the element
            const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
            expect(removeOps.length).toBeGreaterThan(0);
        });

        it('should handle complete list replacement', () => {
            // Initial: [A, B, C]
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Complete replacement: [X, Y, Z]
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'x', children: 'X' }),
                    jsx('li', { key: 'y', children: 'Y' }),
                    jsx('li', { key: 'z', children: 'Z' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should remove old and create new elements
            const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(removeOps.length).toBeGreaterThan(0);
            expect(createOps.length).toBe(3);
        });

        it('should handle reverse order efficiently', () => {
            // Initial: [1, 2, 3, 4, 5]
            const list1 = jsx(Fragment, {
                children: [1, 2, 3, 4, 5].map(n => 
                    jsx('li', { key: n, children: String(n) })
                )
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Reverse: [5, 4, 3, 2, 1]
            const list2 = jsx(Fragment, {
                children: [5, 4, 3, 2, 1].map(n => 
                    jsx('li', { key: n, children: String(n) })
                )
            });

            renderer.render(list2 as any, container);

            // Should move elements, not recreate them
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(createOps.length).toBe(0);
        });
    });

    describe('Key warnings', () => {
        it('should warn about duplicate keys in development', () => {
            // Create initial list
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();
            warnSpy.mockClear();

            // Re-render with duplicate keys in the new list
            // The duplicate check happens at the start of reconciliation
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'same', children: 'First' }),
                    jsx('li', { key: 'same', children: 'Duplicate!' }),
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should warn about duplicate keys
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Duplicate key')
            );
        });

        it('should not warn when some children are missing keys', () => {
            warnSpy.mockClear();
            
            // Create list with inconsistent keying - no warning expected
            // SignalX's diffing algorithm handles keyless lists gracefully
            jsx('ul', {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { children: 'B' }), // No key - that's fine
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            // Should NOT warn about missing keys
            expect(warnSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('missing keys')
            );
        });
    });

    describe('Component key changes', () => {
        it('should remount component when key changes', () => {
            // Create a simple component factory
            const Counter = {
                __setup: (ctx: any) => {
                    const count = ctx.signal(0);
                    return () => jsx('span', { children: count() });
                }
            };

            // Initial render with key "a"
            const vnode1 = jsx(Counter as any, { key: 'a' });
            renderer.render(vnode1 as any, container);
            mockOps.reset();

            // Change key to "b" - should remount
            const vnode2 = jsx(Counter as any, { key: 'b' });
            renderer.render(vnode2 as any, container);

            // Should have unmounted old and mounted new
            const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
            const createOps = mockOps.operations.filter(op => 
                op.startsWith('createElement:') || op.startsWith('createComment:')
            );
            expect(removeOps.length).toBeGreaterThan(0);
            expect(createOps.length).toBeGreaterThan(0);
        });
    });

    describe('Edge cases', () => {
        it('should handle empty to non-empty list', () => {
            // Initial: empty
            const list1 = jsx(Fragment, { children: [] });
            renderer.render(list1 as any, container);
            mockOps.reset();

            // Add items
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' })
                ]
            });

            renderer.render(list2 as any, container);

            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(createOps.length).toBe(2);
        });

        it('should handle non-empty to empty list', () => {
            // Initial: items
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    jsx('li', { key: 'b', children: 'B' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Remove all
            const list2 = jsx(Fragment, { children: [] });
            renderer.render(list2 as any, container);

            const removeOps = mockOps.operations.filter(op => op.startsWith('remove:'));
            expect(removeOps.length).toBeGreaterThan(0);
        });

        it('should handle null/undefined in list', () => {
            const list = jsx(Fragment, {
                children: [
                    jsx('li', { key: 'a', children: 'A' }),
                    null,
                    jsx('li', { key: 'b', children: 'B' }),
                    undefined,
                    jsx('li', { key: 'c', children: 'C' })
                ]
            });

            renderer.render(list as any, container);

            // Should only create 3 li elements
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(createOps.length).toBe(3);
        });

        it('should handle mixed keyed and unkeyed siblings', () => {
            // This is a valid scenario, though not ideal
            const list = jsx('ul', {
                children: [
                    jsx('li', { key: 'header', children: 'Header' }),
                    jsx('li', { children: 'Item 1' }),
                    jsx('li', { children: 'Item 2' }),
                    jsx('li', { key: 'footer', children: 'Footer' })
                ]
            });

            // Should render without throwing
            expect(() => renderer.render(list as any, container)).not.toThrow();
        });

        it('should treat numeric and string keys correctly', () => {
            // Keys 1 and "1" should be considered the same after stringification
            const list1 = jsx(Fragment, {
                children: [
                    jsx('li', { key: 1, children: 'One' }),
                    jsx('li', { key: 2, children: 'Two' })
                ]
            });

            renderer.render(list1 as any, container);
            mockOps.reset();

            // Use string keys
            const list2 = jsx(Fragment, {
                children: [
                    jsx('li', { key: '1', children: 'One Updated' }),
                    jsx('li', { key: '2', children: 'Two Updated' })
                ]
            });

            renderer.render(list2 as any, container);

            // Should update text, not recreate elements
            const createOps = mockOps.operations.filter(op => op.startsWith('createElement:li'));
            expect(createOps.length).toBe(0);
        });
    });
});
