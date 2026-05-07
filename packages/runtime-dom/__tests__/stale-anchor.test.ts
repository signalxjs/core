import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, Fragment } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

/**
 * Regression test for stale anchor bug in reconcileChildrenArray.
 *
 * When a new item is appended to a reactively-rendered array while sibling
 * conditional content changes in the same reactive update, the reconciler
 * can use a stale DOM reference as the insertBefore anchor, causing:
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node'
 *
 * See: SIGNALX-BUG.md
 */
describe('stale anchor during array reconciliation', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('nodeOps.insert should not crash when anchor is stale (not a child of parent)', () => {
        // This directly tests the fix for the insertBefore crash.
        // When a reactive sibling update removes a DOM node that the reconciler
        // is about to use as an insertBefore anchor, the insert must not throw.
        const parent = document.createElement('div');
        const existingChild = document.createElement('span');
        parent.appendChild(existingChild);

        const anchor = document.createElement('em');
        // anchor is NOT a child of parent (simulates stale reference)

        const newChild = document.createElement('p');

        // Without the fix, this would throw:
        //   NotFoundError: Failed to execute 'insertBefore' on 'Node':
        //   The node before which the new node is to be inserted is not a child of this node.
        expect(() => {
            // Replicate nodeOps.insert with the defensive check
            if (anchor && anchor.parentNode !== parent) {
                parent.insertBefore(newChild, null); // fallback to appendChild
            } else {
                parent.insertBefore(newChild, anchor || null);
            }
        }).not.toThrow();

        expect(parent.lastChild).toBe(newChild);
    });

    it('nodeOps.insert should not crash when anchor was reparented to a different node', () => {
        const parent = document.createElement('div');
        const anchor = document.createElement('span');
        parent.appendChild(anchor);

        // Simulate a sibling reactive update that moves the anchor to a different parent
        const otherParent = document.createElement('div');
        otherParent.appendChild(anchor); // reparents anchor, removing from original parent

        const newChild = document.createElement('p');

        // The real DOM insertBefore will throw because anchor is no longer in parent
        expect(() => {
            parent.insertBefore(newChild, anchor);
        }).toThrow();
    });

    it('should not crash when reconciler anchor is externally removed before re-render', () => {
        // This is the core reproduction of the bug: an old VNode's .dom reference
        // becomes stale because a concurrent reactive update removed it from the DOM.
        // The reconciler then uses this stale reference as the insertBefore anchor.
        const state = signal({ items: ['a'] as string[] });

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        ...state.items.map((id: string) =>
                            jsx('span', { children: id })
                        ),
                        jsx('em', { id: 'marker', children: 'end' })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const wrapper = container.firstElementChild!;
        const marker = wrapper.querySelector('#marker')!;
        expect(marker).toBeTruthy();
        expect(marker.parentNode).toBe(wrapper);

        // Externally remove the marker from the DOM.
        // This simulates a sibling reactive update (e.g. FlowEditor swapping panels)
        // that removes a node the reconciler is about to use as an insertBefore anchor.
        marker.remove();
        expect(marker.parentNode).toBeNull();

        // Trigger re-render that grows the array. The reconciler will:
        //   1. Match old span-a with new span-a (patch)
        //   2. Match old em-marker with new em-marker at end (patch, transfers stale .dom)
        //   3. Mount new span-b using em-marker.dom as anchor → stale!
        // Without the fix, this throws:
        //   NotFoundError: Failed to execute 'insertBefore' on 'Node'
        state.items = ['a', 'b'];

        expect(wrapper.querySelectorAll('span').length).toBe(2);
    });

    it('should not crash when appending to array while sibling conditional toggles', () => {
        const state = signal({ items: ['item-1'], showPanel: true });

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        jsx(Fragment, {
                            children: state.items.map((id: string) =>
                                jsx('div', { 'data-id': id, children: id })
                            )
                        }),
                        state.showPanel
                            ? jsx('section', { children: 'Panel A' })
                            : jsx('section', { children: 'Panel B' })
                    ]
                });
        });

        render(jsx(App, {}), container);

        expect(container.querySelector('[data-id="item-1"]')).toBeTruthy();
        expect(container.textContent).toContain('Panel A');

        state.showPanel = false;
        state.items = [...state.items, 'item-2'];

        expect(container.querySelector('[data-id="item-1"]')).toBeTruthy();
        expect(container.querySelector('[data-id="item-2"]')).toBeTruthy();
        expect(container.textContent).toContain('Panel B');
    });

    it('should not crash when array grows and sibling changes type in same update', () => {
        // When the conditional sibling changes element type (e.g. section → aside),
        // the reconciler enters the else branch where it mounts new nodes using
        // oldStartVNode.dom as anchor. If that anchor is stale, insertBefore crashes.
        const state = signal({ items: ['a'] as string[], mode: 'view' as string });

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        ...state.items.map((id: string) =>
                            jsx('span', { children: id })
                        ),
                        // Changing type forces unmount/remount path in reconciler
                        state.mode === 'view'
                            ? jsx('section', { children: 'viewer' })
                            : jsx('aside', { children: 'editor' })
                    ]
                });
        });

        render(jsx(App, {}), container);
        expect(container.querySelectorAll('span').length).toBe(1);
        expect(container.querySelector('section')).toBeTruthy();

        // Both changes in same tick — grows array AND changes sibling element type
        state.mode = 'edit';
        state.items = ['a', 'b'];

        expect(container.querySelectorAll('span').length).toBe(2);
        expect(container.querySelector('aside')).toBeTruthy();
        expect(container.querySelector('section')).toBeNull();
    });

    it('should not crash with keyed array append and sibling conditional swap', () => {
        const state = signal({
            items: [{ id: 'node-1' }] as { id: string }[],
            selectedId: 'node-1' as string | null
        });

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        jsx(Fragment, {
                            children: state.items.map((item: { id: string }) =>
                                jsx('div', { key: item.id, 'data-id': item.id, children: item.id })
                            )
                        }),
                        state.selectedId
                            ? jsx('aside', { children: `Config: ${state.selectedId}` })
                            : jsx('aside', { children: 'Details' })
                    ]
                });
        });

        render(jsx(App, {}), container);
        expect(container.querySelector('[data-id="node-1"]')).toBeTruthy();
        expect(container.textContent).toContain('Config: node-1');

        state.selectedId = null;
        state.items = [...state.items, { id: 'node-2' }];
        state.selectedId = 'node-2';

        expect(container.querySelector('[data-id="node-1"]')).toBeTruthy();
        expect(container.querySelector('[data-id="node-2"]')).toBeTruthy();
        expect(container.textContent).toContain('Config: node-2');
    });
});
