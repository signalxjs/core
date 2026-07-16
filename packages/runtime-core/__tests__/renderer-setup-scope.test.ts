import { describe, it, expect, beforeEach } from 'vitest';
import { createRenderer } from '../src/renderer';
import { jsx, VNode } from '../src/jsx-runtime';
import { component } from '../src/component';
import { signal, effect, watch, computed } from '@sigx/reactivity';
import type { ComponentSetupContext } from '../src/component-types';

/**
 * Integration tests for setup-scope disposal (core#288): effect()/watch()
 * created directly in a component's setup are torn down on unmount, after the
 * onUnmounted hooks run.
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
    const createNode = (type: string): MockNode => ({
        id: ++nodeIdCounter, type, children: [], textContent: '', parentNode: null
    });
    return {
        createElement: (type: string) => createNode(type),
        createText: (text: string) => { const n = createNode('TEXT'); n.textContent = text; return n; },
        createComment: () => createNode('COMMENT'),
        insert: (child: MockNode, parent: MockNode, anchor?: MockNode | null) => {
            if (child.parentNode) {
                const o = child.parentNode.children.indexOf(child);
                if (o > -1) child.parentNode.children.splice(o, 1);
            }
            if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, child);
            else parent.children.push(child);
            child.parentNode = parent;
        },
        remove: (child: MockNode) => {
            if (child.parentNode) {
                const i = child.parentNode.children.indexOf(child);
                if (i > -1) child.parentNode.children.splice(i, 1);
            }
        },
        patchProp: (el: MockNode, key: string, _p: any, next: any) => { el[key] = next; },
        setText: (n: MockNode, t: string) => { n.textContent = t; },
        setElementText: (el: MockNode, t: string) => { el.textContent = t; },
        parentNode: (n: MockNode) => n.parentNode,
        nextSibling: (n: MockNode) => {
            if (!n.parentNode) return null;
            const i = n.parentNode.children.indexOf(n);
            return n.parentNode.children[i + 1] || null;
        }
    };
}

describe('Renderer - setup-scope disposal (core#288)', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
    });

    it('disposes setup effect()/watch() on unmount, after onUnmounted', () => {
        const s = signal({ n: 0 });
        const effectRuns: number[] = [];
        const watchRuns: number[] = [];
        const events: string[] = [];
        let doubledSnapshot = -1;

        const Cmp = component((ctx: ComponentSetupContext) => {
            const doubled = computed(() => s.n * 2);
            effect(() => { effectRuns.push(s.n); });
            watch(() => s.n, (n) => { watchRuns.push(n); });
            ctx.onUnmounted(() => {
                events.push('unmounted');
                // The watch is still live here (disposal happens AFTER
                // onUnmounted): a write now must still reach it.
                s.n = 99;
                doubledSnapshot = doubled.value; // computed still readable
            });
            return () => jsx('div', { children: 'static' });
        });

        const vnode = Cmp({}) as VNode;
        renderer.mount(vnode, container as any);
        expect(effectRuns).toEqual([0]);        // effect ran on creation
        expect(watchRuns).toEqual([]);          // watch is not immediate

        // While mounted, writes drive both.
        s.n = 1;
        expect(effectRuns).toEqual([0, 1]);
        expect(watchRuns).toEqual([1]);

        // Unmount: onUnmounted runs (and its s.n = 99 still reaches the live
        // effect/watch), THEN the setup reactions are disposed.
        renderer.unmount(vnode, container as any);
        expect(events).toEqual(['unmounted']);
        expect(effectRuns).toEqual([0, 1, 99]);
        expect(watchRuns).toEqual([1, 99]);
        expect(doubledSnapshot).toBe(198);      // computed still worked in onUnmounted

        // After unmount, further writes reach nothing (disposed).
        s.n = 100;
        expect(effectRuns).toEqual([0, 1, 99]);
        expect(watchRuns).toEqual([1, 99]);

        // The computed is still readable post-unmount (never disposed).
        expect(computed(() => s.n).value).toBe(100);
    });

    it('unmounts a reaction-less component without error', () => {
        const Cmp = component(() => () => jsx('div', { children: 'x' }));
        const vnode = Cmp({}) as VNode;
        renderer.mount(vnode, container as any);
        expect(() => renderer.unmount(vnode, container as any)).not.toThrow();
    });
});
