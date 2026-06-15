/**
 * Tests for the full-tree scheduleComponentHydration() path (used by the islands
 * plugin's client.hydrateComponent hook). Complements hydration-strategies.test.tsx
 * by exercising the requestIdleCallback branch, the visible/media cleanup wiring,
 * and the async-placeholder skip path. Also covers initIslandHydration's host
 * accessor wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import {
    scheduleComponentHydration,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    initIslandHydration
} from '../src/client/hydrate-islands';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts
} from './test-utils';

let testId = 0;
function uniqueName(base: string): string {
    return `STH_${base}_${++testId}`;
}

function islandVNode(name: string, props: Record<string, any> = {}) {
    const Comp = component(() => () => <span class="sth">x</span>, { name });
    return { type: Comp as any, props, key: null, children: [], dom: null };
}

describe('scheduleComponentHydration (full-tree path)', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('schedules idle via requestIdleCallback and cleanupPendingHydrations cancels it', () => {
        const idleCbs: Array<() => void> = [];
        const cancelSpy = vi.fn();
        const originalRIC = (globalThis as any).requestIdleCallback;
        const originalCIC = (globalThis as any).cancelIdleCallback;
        (window as any).requestIdleCallback = (cb: () => void) => { idleCbs.push(cb); return 7; };
        (window as any).cancelIdleCallback = cancelSpy;

        container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const vnode = islandVNode(uniqueName('Idle'));
        const dom = container.firstChild;

        scheduleComponentHydration(vnode as any, dom, container, { strategy: 'idle' });
        expect(idleCbs.length).toBe(1); // RIC branch taken, not setTimeout

        // Cancel before it fires → cancelIdleCallback invoked.
        cleanupPendingHydrations();
        expect(cancelSpy).toHaveBeenCalledWith(7);

        (window as any).requestIdleCallback = originalRIC;
        (window as any).cancelIdleCallback = originalCIC;
    });

    it('schedules visible and registers a disconnect cleanup', () => {
        let disconnected = false;
        (globalThis as any).IntersectionObserver = function (this: any) {
            this.observe = vi.fn();
            this.disconnect = () => { disconnected = true; };
            this.unobserve = vi.fn();
        };

        container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const vnode = islandVNode(uniqueName('Visible'));
        const dom = container.firstChild;

        scheduleComponentHydration(vnode as any, dom, container, { strategy: 'visible' });
        // Cleanup should disconnect the observer.
        cleanupPendingHydrations();
        expect(disconnected).toBe(true);

        delete (globalThis as any).IntersectionObserver;
    });

    it('defers media and removes the listener on cleanup', () => {
        const removeEventListener = vi.fn();
        (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: false, media: query, addEventListener: vi.fn(), removeEventListener
        }));

        container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const vnode = islandVNode(uniqueName('Media'));
        const dom = container.firstChild;

        scheduleComponentHydration(vnode as any, dom, container, { strategy: 'media', media: '(max-width: 500px)' });
        cleanupPendingHydrations();
        expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

        delete (globalThis as any).matchMedia;
    });

    it('hydrates media immediately when the query already matches', () => {
        (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn()
        }));

        container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const name = uniqueName('MediaMatch');
        let setup = false;
        const Comp = component(() => { setup = true; return () => <span class="sth">x</span>; }, { name });
        const vnode = { type: Comp as any, props: {}, key: null, children: [], dom: null };

        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'media', media: '(max-width: 500px)' });
        expect(setup).toBe(true);

        delete (globalThis as any).matchMedia;
    });

    it('calls visible callback immediately (no observer) when no element precedes the marker', () => {
        let observerConstructed = false;
        (globalThis as any).IntersectionObserver = function (this: any) {
            observerConstructed = true;
            this.observe = vi.fn(); this.disconnect = vi.fn(); this.unobserve = vi.fn();
        };

        // dom = the comment marker, no element node in the range.
        container = createSSRContainer('<!--$c:1-->');
        const name = uniqueName('VisNoEl');
        let setup = false;
        const Comp = component(() => { setup = true; return () => <span>x</span>; }, { name });
        const vnode = { type: Comp as any, props: {}, key: null, children: [], dom: null };

        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'visible' });
        // observeComponentVisibility found no element → invoked callback directly.
        expect(observerConstructed).toBe(false);
        expect(setup).toBe(true);

        delete (globalThis as any).IntersectionObserver;
    });

    it('skips async placeholders and registers the component instead of hydrating', () => {
        container = createSSRContainer('<div data-async-placeholder="1">loading</div><!--$c:1-->');
        const name = uniqueName('AsyncPh');
        let setup = false;
        const Comp = component(() => { setup = true; return () => <span>x</span>; }, { name });
        // Give it an __islandId so registerComponent is keyed (non-Anonymous).
        (Comp as any).__islandId = name;
        const vnode = { type: Comp as any, props: {}, key: null, children: [], dom: null };

        const next = scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'load' });
        // Placeholder path: does NOT hydrate, returns the next node.
        expect(setup).toBe(false);
        expect(next).not.toBeUndefined();
    });
});

describe('initIslandHydration', () => {
    afterEach(() => {
        // Reset the host accessors back to inert.
        initIslandHydration({
            getCurrentAppContext: () => undefined,
            setCurrentAppContext: () => {},
            setPendingServerState: () => {}
        });
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('wires host accessors that are then used during load hydration', () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const getCtx = vi.fn(() => ({ app: true }));
        const setCtx = vi.fn();
        const setState = vi.fn();
        initIslandHydration({
            getCurrentAppContext: getCtx,
            setCurrentAppContext: setCtx,
            setPendingServerState: setState
        });

        const container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const name = `Init_${++testId}`;
        const Comp = component(() => () => <span class="sth">x</span>, { name });
        const vnode = { type: Comp as any, props: {}, key: null, children: [], dom: null };

        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'load' });

        // getCurrentAppContext is read to capture context; setCurrentAppContext is
        // used to swap context around the hydrate call.
        expect(getCtx).toHaveBeenCalled();
        expect(setCtx).toHaveBeenCalled();

        cleanupContainer(container);
    });
});
