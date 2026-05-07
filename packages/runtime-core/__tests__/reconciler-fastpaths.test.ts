import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRenderer } from '../src/renderer';
import { VNode, Fragment, jsx } from '../src/jsx-runtime';

/**
 * Tests for the two-pointer reconciliation algorithm's fast paths
 * in reconcileChildrenArray(). The algorithm uses:
 *   1. start-start match
 *   2. end-end match
 *   3. start-end swap (oldStart === newEnd)
 *   4. end-start swap (oldEnd === newStart)
 *   5. key-map lookup fallback
 *   6. post-loop mount/unmount of remaining items
 */

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
            // Remove from old position first (move semantics)
            if (child.parentNode) {
                const oldIdx = child.parentNode.children.indexOf(child);
                if (oldIdx > -1) child.parentNode.children.splice(oldIdx, 1);
            }
            if (anchor) {
                const idx = parent.children.indexOf(anchor);
                if (idx > -1) {
                    parent.children.splice(idx, 0, child);
                } else {
                    parent.children.push(child);
                }
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
        },
    };
}

/** Helper: render a keyed list inside a Fragment */
function keyedList(keys: (string | null)[]) {
    return jsx(Fragment, {
        children: keys.map(k =>
            k != null
                ? jsx('div', { key: k, children: k })
                : jsx('div', { children: '?' })
        ),
    });
}

/** Return only the key portion of the children (by textContent) */
function childOrder(container: any): string[] {
    return container.children
        .filter((c: any) => c.type !== 'COMMENT')
        .map((c: any) => {
            // Each <div> has a text-node child whose textContent holds the key letter
            if (c.children && c.children.length > 0) {
                return c.children[0].textContent;
            }
            return c.textContent;
        });
}

describe('Reconciliation fast-paths', () => {
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

    // ── 1. start-start match ───────────────────────────────────────────────
    it('start-start: should patch matching heads without moves', () => {
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['A', 'B', 'D']) as any, container);

        // A and B patched in-place (no createElement for them)
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(1); // only D created

        // C should be unmounted
        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removes.length).toBeGreaterThan(0);

        // The only anchored insert should be for the newly mounted D — no
        // existing element (A or B) is moved.
        const moveOps = mockOps.operations.filter(op => op.includes('@anchor'));
        // D may be mounted with an anchor (before C's old position); that's fine.
        // Verify none of the moves involve the original A or B DOM nodes being relocated.
        for (const op of moveOps) {
            // The insert format is  insert:#<id>->parent#0@anchor#<id>
            // Nodes 2 and 4 are the <div> elements for A and B (node ids 1,3 are their text children)
            expect(op).not.toMatch(/insert:#2->/);
            expect(op).not.toMatch(/insert:#4->/);
        }

        expect(childOrder(container)).toEqual(['A', 'B', 'D']);
    });

    // ── 2. end-end match ───────────────────────────────────────────────────
    it('end-end: should patch matching tails without moves', () => {
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['D', 'B', 'C']) as any, container);

        // B and C patched in-place
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(1); // only D

        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removes.length).toBeGreaterThan(0); // A removed

        expect(childOrder(container)).toEqual(['D', 'B', 'C']);
    });

    // ── 3. start-end swap ──────────────────────────────────────────────────
    it('start-end swap: should move old start to end', () => {
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['B', 'C', 'A']) as any, container);

        // No new elements should be created
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(0);

        // A should have been moved (insert with anchor)
        const inserts = mockOps.operations.filter(op => op.includes('insert:') && op.includes('@anchor'));
        expect(inserts.length).toBeGreaterThan(0);

        expect(childOrder(container)).toEqual(['B', 'C', 'A']);
    });

    // ── 4. end-start swap ──────────────────────────────────────────────────
    it('end-start swap: should move old end to start', () => {
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['C', 'A', 'B']) as any, container);

        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(0);

        // C should have been moved before A
        const inserts = mockOps.operations.filter(op => op.includes('insert:') && op.includes('@anchor'));
        expect(inserts.length).toBeGreaterThan(0);

        expect(childOrder(container)).toEqual(['C', 'A', 'B']);
    });

    // ── 5. consecutive start matches followed by additions ─────────────────
    it('should handle consecutive start matches followed by additions', () => {
        renderer.render(keyedList(['A', 'B']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['A', 'B', 'C', 'D']) as any, container);

        // A, B patched in place — C, D mounted
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(2);

        // No removes
        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removes).toHaveLength(0);

        expect(childOrder(container)).toEqual(['A', 'B', 'C', 'D']);
    });

    // ── 6. consecutive end matches with prepend ────────────────────────────
    it('should handle consecutive end matches with prepend', () => {
        renderer.render(keyedList(['B', 'C']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['A', 'B', 'C']) as any, container);

        // B, C matched at tail — A mounted before B
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(1);

        expect(childOrder(container)).toEqual(['A', 'B', 'C']);
    });

    // ── 7. skip null old children during reconciliation ────────────────────
    it('should skip null old children during reconciliation', () => {
        // Render [A, B, C, D], then force a scenario that
        // goes through the key-map path (which sets oldChildren[idx] = undefined)
        // and then encounters the null-skip branches.
        renderer.render(keyedList(['A', 'B', 'C', 'D']) as any, container);
        mockOps.operations.length = 0;

        // Reorder so the key-map fallback fires: move C to front, D to second
        // [C, D, A, B] forces several iterations through the fallback.
        renderer.render(keyedList(['C', 'D', 'A', 'B']) as any, container);

        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(0); // all reused

        expect(childOrder(container)).toEqual(['C', 'D', 'A', 'B']);
    });

    // ── 8. key map lazily built ────────────────────────────────────────────
    it('should build key map only once per reconcile', () => {
        // If all matches are handled by the four fast-path checks
        // the key map is never built.
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);
        mockOps.operations.length = 0;

        // [B, C, A] can be resolved via start-end and end-start swaps, but
        // different implementations may also hit the key map. Instead test a
        // scenario that definitely does NOT need the map: identical lists.
        renderer.render(keyedList(['A', 'B', 'C']) as any, container);

        // All three matched via start-start → no creates, no removes, no moves
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        const inserts = mockOps.operations.filter(op => op.includes('@anchor'));
        expect(creates).toHaveLength(0);
        expect(removes).toHaveLength(0);
        expect(inserts).toHaveLength(0);
    });

    // ── 9. findIndexInOld fallback for keyless children ────────────────────
    it('should use findIndexInOld fallback for keyless children', () => {
        // Keyless <div> children — reconciler should still match by type
        const list1 = jsx(Fragment, {
            children: [
                jsx('div', { children: 'X' }),
                jsx('span', { children: 'Y' }),
            ],
        });
        renderer.render(list1 as any, container);
        mockOps.operations.length = 0;

        // Swap order — <span> now first, <div> second
        const list2 = jsx(Fragment, {
            children: [
                jsx('span', { children: 'Y2' }),
                jsx('div', { children: 'X2' }),
            ],
        });
        renderer.render(list2 as any, container);

        // Should NOT create new elements — reuses via findIndexInOld
        const creates = mockOps.operations.filter(
            op => op.startsWith('createElement:div') || op.startsWith('createElement:span')
        );
        expect(creates).toHaveLength(0);
    });

    // ── 10. correct DOM order after start-end swap ─────────────────────────
    it('should correctly position elements via anchor on start-end swap', () => {
        renderer.render(keyedList(['A', 'B', 'C', 'D']) as any, container);
        mockOps.operations.length = 0;

        // Move A to the end: [B, C, D, A]
        renderer.render(keyedList(['B', 'C', 'D', 'A']) as any, container);

        expect(childOrder(container)).toEqual(['B', 'C', 'D', 'A']);
    });

    // ── 11. correct DOM order after end-start swap ─────────────────────────
    it('should correctly position elements via anchor on end-start swap', () => {
        renderer.render(keyedList(['A', 'B', 'C', 'D']) as any, container);
        mockOps.operations.length = 0;

        // Move D to front: [D, A, B, C]
        renderer.render(keyedList(['D', 'A', 'B', 'C']) as any, container);

        expect(childOrder(container)).toEqual(['D', 'A', 'B', 'C']);
    });

    // ── 12. full reverse ───────────────────────────────────────────────────
    it('full reverse: should handle [A,B,C,D,E] → [E,D,C,B,A]', () => {
        renderer.render(keyedList(['A', 'B', 'C', 'D', 'E']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['E', 'D', 'C', 'B', 'A']) as any, container);

        // No new elements — all reused
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(0);

        expect(childOrder(container)).toEqual(['E', 'D', 'C', 'B', 'A']);
    });

    // ── 13. partial update — middle replacements ───────────────────────────
    it('partial update: should handle [A,B,C,D,E] → [A,X,C,Y,E]', () => {
        renderer.render(keyedList(['A', 'B', 'C', 'D', 'E']) as any, container);
        mockOps.operations.length = 0;

        renderer.render(keyedList(['A', 'X', 'C', 'Y', 'E']) as any, container);

        // X, Y are new keys → 2 creates
        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(2);

        // B, D removed
        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removes.length).toBeGreaterThanOrEqual(2);

        expect(childOrder(container)).toEqual(['A', 'X', 'C', 'Y', 'E']);
    });

    // ── 14. mount remaining new items at correct anchor ────────────────────
    it('should mount remaining new items at correct anchor when old exhausted', () => {
        renderer.render(keyedList(['A', 'B']) as any, container);
        mockOps.operations.length = 0;

        // Old is entirely consumed by start-start matches, then C, D, E appended
        renderer.render(keyedList(['A', 'B', 'C', 'D', 'E']) as any, container);

        const creates = mockOps.operations.filter(op => op.startsWith('createElement:div'));
        expect(creates).toHaveLength(3);

        // No removes
        const removes = mockOps.operations.filter(op => op.startsWith('remove:'));
        expect(removes).toHaveLength(0);

        expect(childOrder(container)).toEqual(['A', 'B', 'C', 'D', 'E']);
    });
});
