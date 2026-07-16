import { describe, it, expect, beforeEach } from 'vitest';
import { createRenderer } from '../src/renderer';
import { jsx, VNode } from '../src/jsx-runtime';
import { component } from '../src/component';
import type { ComponentSetupContext } from '../src/component-types';

/**
 * Integration tests for the dev-only `ctx.__hmrReload(setup)` primitive
 * (core#107). A hot update re-runs a component's setup against the SAME
 * instance; before this primitive the renderer's lifecycle-hook lists only
 * grew (each re-run appended), so old onUpdated/onUnmounted callbacks
 * accumulated and resources from prior runs were never torn down.
 *
 * `__hmrReload` must instead perform a proper re-setup: dispose the previous
 * run's onUnmounted cleanups, clear all four hook lists, re-run the new setup,
 * then re-fire the new created/mounted hooks and re-render.
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
        createText: (text: string) => {
            const n = createNode('TEXT');
            n.textContent = text;
            return n;
        },
        createComment: () => createNode('COMMENT'),
        insert: (child: MockNode, parent: MockNode, anchor?: MockNode | null) => {
            if (child.parentNode) {
                const oldIdx = child.parentNode.children.indexOf(child);
                if (oldIdx > -1) child.parentNode.children.splice(oldIdx, 1);
            }
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
        patchProp: (el: MockNode, key: string, _prev: any, next: any) => { el[key] = next; },
        setText: (node: MockNode, text: string) => { node.textContent = text; },
        setElementText: (el: MockNode, text: string) => { el.textContent = text; },
        parentNode: (node: MockNode) => node.parentNode,
        nextSibling: (node: MockNode) => {
            if (!node.parentNode) return null;
            const idx = node.parentNode.children.indexOf(node);
            return node.parentNode.children[idx + 1] || null;
        }
    };
}

describe('Renderer - ctx.__hmrReload() (core#107)', () => {
    let mockOps: ReturnType<typeof createMockDOMOperations>;
    let renderer: ReturnType<typeof createRenderer>;
    let container: MockNode;
    let events: string[];
    let capturedCtx: ComponentSetupContext | null;

    /** A setup that tags every lifecycle event with `tag` and renders `<div>{tag}</div>`. */
    function makeSetup(tag: string) {
        return (ctx: ComponentSetupContext) => {
            capturedCtx = ctx;
            ctx.onCreated(() => events.push(`created:${tag}`));
            ctx.onMounted(() => events.push(`mounted:${tag}`));
            ctx.onUpdated(() => events.push(`updated:${tag}`));
            ctx.onUnmounted(() => events.push(`unmounted:${tag}`));
            return () => jsx('div', { children: tag });
        };
    }

    function divText(): string | undefined {
        const div = container.children.find(c => c.type === 'div');
        return div?.children[0]?.textContent;
    }

    beforeEach(() => {
        mockOps = createMockDOMOperations();
        renderer = createRenderer(mockOps as any);
        container = { id: 0, type: 'container', children: [], textContent: '', parentNode: null };
        events = [];
        capturedCtx = null;
    });

    it('exposes __hmrReload on the instance ctx in dev builds', () => {
        const Cmp = component(makeSetup('v1'));
        renderer.mount(Cmp({}) as VNode, container as any);
        expect(typeof capturedCtx!.__hmrReload).toBe('function');
    });

    it('re-setups the instance: disposes old cleanups, re-fires created/mounted, re-renders', () => {
        const Cmp = component(makeSetup('v1'));
        renderer.mount(Cmp({}) as VNode, container as any);

        // Initial mount fires created + mounted (no updated on the first render).
        expect(events).toEqual(['created:v1', 'mounted:v1']);
        expect(divText()).toBe('v1');

        // A normal re-render fires updated for the current setup body.
        capturedCtx!.update();
        expect(events).toEqual(['created:v1', 'mounted:v1', 'updated:v1']);

        // Hot update: reload against a NEW setup body.
        capturedCtx!.__hmrReload!(makeSetup('v2'));

        // The previous run's onUnmounted ran once (teardown), then the new
        // setup's created/updated/mounted fired, and the DOM shows v2.
        expect(events).toEqual([
            'created:v1', 'mounted:v1', 'updated:v1',
            'unmounted:v1',            // prior run disposed
            'created:v2',              // new setup created
            'updated:v2',             // reload re-render
            'mounted:v2'               // new setup mounted
        ]);
        expect(divText()).toBe('v2');
    });

    it('does not accumulate hooks across reloads', () => {
        const Cmp = component(makeSetup('v1'));
        renderer.mount(Cmp({}) as VNode, container as any);
        capturedCtx!.__hmrReload!(makeSetup('v2'));

        // Reset the log and drive one more plain re-render.
        events = [];
        capturedCtx!.update();

        // Only the CURRENT (v2) onUpdated fires — the v1 callback was cleared,
        // not left to fire alongside it (the core#107 accumulation bug).
        expect(events).toEqual(['updated:v2']);
        expect(events).not.toContain('updated:v1');
    });

    it('runs the previous run\'s onUnmounted exactly once per reload', () => {
        const Cmp = component(makeSetup('v1'));
        renderer.mount(Cmp({}) as VNode, container as any);

        capturedCtx!.__hmrReload!(makeSetup('v2'));
        capturedCtx!.__hmrReload!(makeSetup('v3'));

        // Each reload tears down exactly the immediately-preceding run.
        expect(events.filter(e => e === 'unmounted:v1')).toHaveLength(1);
        expect(events.filter(e => e === 'unmounted:v2')).toHaveLength(1);
        expect(events).not.toContain('unmounted:v3');
        expect(divText()).toBe('v3');
    });

    it('still tears down the latest run on a real unmount after reloads', () => {
        const vnode = component(makeSetup('v1'))({}) as VNode;
        renderer.mount(vnode, container as any);
        capturedCtx!.__hmrReload!(makeSetup('v2'));

        events = [];
        renderer.unmount(vnode, container as any);

        // Only the latest (v2) onUnmounted fires — the v1 one was already
        // disposed by the reload, so it must NOT fire again here.
        expect(events).toEqual(['unmounted:v2']);
    });
});
