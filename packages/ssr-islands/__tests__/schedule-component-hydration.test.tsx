/**
 * Tests for the full-tree scheduleComponentHydration() path (used by the islands
 * plugin's client.hydrateComponent hook). Complements hydration-strategies.test.tsx
 * by exercising the requestIdleCallback branch, the visible/media cleanup wiring,
 * the async-placeholder skip path, and walk-path server-state restoration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import {
    scheduleComponentHydration,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from '../src/client/hydrate-islands';
import { invalidateIslandCache } from '../src/client/island-context';
import { islandsPlugin } from '../src/plugin';
import { registerClientPlugin, clearClientPlugins } from '@sigx/server-renderer/client';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    createIslandDataScript
} from './test-utils';
import type { SSRSignalFn } from '../src/server/render-component';

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

    it('does not leak client:* directive props into the hydrated component', () => {
        // The walk path must strip directives before delegating to core (which has
        // no directive knowledge), matching the data-driven hydrateIsland() path —
        // see signalxjs/core#126.
        let seen: Record<string, any> = {};
        const Comp = component((ctx) => {
            seen = { ...ctx.props };
            return () => <span class="sth">x</span>;
        }, { name: uniqueName('NoLeak') });

        container = createSSRContainer('<span class="sth">x</span><!--$c:1-->');
        const vnode = {
            type: Comp as any,
            props: { 'client:load': true, title: 'hello' },
            key: null,
            children: [],
            dom: null
        };

        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'load' });

        // Real prop survives; directive does not (neither as value nor as a spread key).
        expect(seen.title).toBe('hello');
        expect('client:load' in seen).toBe(false);
    });
});

describe('scheduleComponentHydration — server-state restoration (#120)', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        invalidateIslandCache();
        invalidateMarkerIndex();
        clearClientPlugins();
        registerClientPlugin(islandsPlugin());
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        invalidateIslandCache();
        invalidateMarkerIndex();
        clearClientPlugins();
        vi.restoreAllMocks();
    });

    it('seeds an island signal from the server-captured state via the new client seam', async () => {
        const name = `Restore_${++testId}`;
        // Literal initial is 0; the server captured 7. The restoring signal must
        // seed 7 so a subsequent increment produces 8 (not 1).
        const Comp = component((ctx) => {
            const ssrSignal = ctx.signal as unknown as SSRSignalFn;
            const count = ssrSignal(0, 'count');
            return () => (
                <div>
                    <span class="count">{count.value}</span>
                    <button onClick={() => { count.value++; }}>+</button>
                </div>
            );
        }, { name });

        // SSR DOM reflects the captured value (server renders the final state).
        container = createSSRContainer(
            '<div><span class="count">7</span><button>+</button></div><!--$c:1-->'
        );
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {}, state: { count: 7 } }
        });

        const vnode = { type: Comp as any, props: { 'client:load': true }, key: null, children: [], dom: null };
        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'load' });
        await Promise.resolve();

        const button = container.querySelector('button')!;
        button.click();
        await Promise.resolve();

        // 7 (restored) + 1 = 8 — proves the signal was seeded from server state.
        expect(container.querySelector('.count')!.textContent).toBe('8');
    });

    it('leaves a state-less island on its literal initial value', async () => {
        const name = `NoState_${++testId}`;
        const Comp = component((ctx) => {
            const ssrSignal = ctx.signal as unknown as SSRSignalFn;
            const count = ssrSignal(0, 'count');
            return () => (
                <div>
                    <span class="count">{count.value}</span>
                    <button onClick={() => { count.value++; }}>+</button>
                </div>
            );
        }, { name });

        container = createSSRContainer(
            '<div><span class="count">0</span><button>+</button></div><!--$c:1-->'
        );
        // Island data without a `state` field.
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {} }
        });

        const vnode = { type: Comp as any, props: { 'client:load': true }, key: null, children: [], dom: null };
        scheduleComponentHydration(vnode as any, container.firstChild, container, { strategy: 'load' });
        await Promise.resolve();

        container.querySelector('button')!.click();
        await Promise.resolve();

        // 0 (initial) + 1 = 1 — no restoration, still interactive.
        expect(container.querySelector('.count')!.textContent).toBe('1');
    });
});
