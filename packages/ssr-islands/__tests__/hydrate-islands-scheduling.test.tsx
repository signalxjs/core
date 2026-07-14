/**
 * Tests for client/hydrate-islands.ts scheduling paths driven through
 * hydrateIslands() (the __SIGX_ISLANDS__ data path), plus the standalone
 * helpers: cleanupPendingHydrations, invalidateMarkerIndex, seedPendingServerState.
 *
 * These complement hydration-strategies.test.tsx (which drives the full-tree
 * scheduleComponentHydration path via hydrate()) by exercising the islands-data
 * scheduleHydration / scheduleByStrategy branches and their cleanup wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import {
    hydrateIslands,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    seedPendingServerState
} from '../src/client/hydrate-islands';
import { registerComponent } from '../src/client/registry';
import {
    createSSRContainer,
    cleanupContainer,
    createIslandDataScript,
    cleanupScripts,
    nextTick
} from './test-utils';

let testId = 0;
function uniqueName(base: string): string {
    return `Sched_${base}_${++testId}`;
}

describe('hydrateIslands scheduling', () => {
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

    // ─── parse + marker error paths ──────────────────────────────────

    it('logs and bails when island data is invalid JSON', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const script = document.createElement('script');
        script.id = '__SIGX_ISLANDS__';
        script.type = 'application/json';
        script.textContent = '{ broken';
        document.head.appendChild(script);

        container = createSSRContainer('<span>x</span><!--$c:1-->');
        expect(() => hydrateIslands()).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith('Failed to parse island data');
    });

    it('warns when an island marker is not found in the DOM', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const name = uniqueName('NoMarker');
        registerComponent(name, component(() => () => <span>x</span>, { name }));

        // No <!--$c:7--> marker present for id 7.
        container = createSSRContainer('<span>x</span>');
        createIslandDataScript({ '7': { strategy: 'load', componentId: name, props: {} } });

        hydrateIslands();
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('7');
    });

    // ─── idle strategy ───────────────────────────────────────────────

    it('schedules idle hydration via requestIdleCallback and cleans up its pending entry', async () => {
        const idleCbs: Array<() => void> = [];
        const originalRIC = (globalThis as any).requestIdleCallback;
        const originalCIC = (globalThis as any).cancelIdleCallback;
        (globalThis as any).requestIdleCallback = (cb: () => void) => { idleCbs.push(cb); return idleCbs.length; };
        (globalThis as any).cancelIdleCallback = vi.fn();

        let hydrated = false;
        const name = uniqueName('Idle');
        registerComponent(name, component(() => { hydrated = true; return () => <span>idle</span>; }, { name }));

        container = createSSRContainer('<span>idle</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'idle', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrated).toBe(false); // idle not fired yet

        idleCbs.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();
        expect(hydrated).toBe(true);

        (globalThis as any).requestIdleCallback = originalRIC;
        (globalThis as any).cancelIdleCallback = originalCIC;
    });

    it('falls back to setTimeout for idle when requestIdleCallback is unavailable', async () => {
        const originalRIC = (globalThis as any).requestIdleCallback;
        delete (globalThis as any).requestIdleCallback;

        let hydrated = false;
        const name = uniqueName('IdleFallback');
        registerComponent(name, component(() => { hydrated = true; return () => <span>idle</span>; }, { name }));

        container = createSSRContainer('<span>idle</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'idle', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(250);
        await nextTick();
        expect(hydrated).toBe(true);

        (globalThis as any).requestIdleCallback = originalRIC;
    });

    it('cleanupPendingHydrations cancels a pending idle island before it hydrates', async () => {
        const originalRIC = (globalThis as any).requestIdleCallback;
        delete (globalThis as any).requestIdleCallback; // use setTimeout path

        let hydrated = false;
        const name = uniqueName('IdleCancel');
        registerComponent(name, component(() => { hydrated = true; return () => <span>idle</span>; }, { name }));

        container = createSSRContainer('<span>idle</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'idle', componentId: name, props: {} } });

        hydrateIslands();
        // Cancel before the 200ms timeout fires.
        cleanupPendingHydrations();
        await vi.advanceTimersByTimeAsync(300);
        await nextTick();
        expect(hydrated).toBe(false);

        (globalThis as any).requestIdleCallback = originalRIC;
    });

    // ─── media strategy ──────────────────────────────────────────────

    it('hydrates a media island immediately when the query already matches', async () => {
        (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn()
        }));

        let hydrated = false;
        const name = uniqueName('MediaMatch');
        registerComponent(name, component(() => { hydrated = true; return () => <span>m</span>; }, { name }));

        container = createSSRContainer('<span>m</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'media', media: '(max-width: 600px)', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();
        expect(hydrated).toBe(true);

        delete (globalThis as any).matchMedia;
    });

    it('defers a media island until the query change fires, then cleans up the listener', async () => {
        const listeners: Array<(e: any) => void> = [];
        const removeEventListener = vi.fn();
        (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addEventListener: (ev: string, l: (e: any) => void) => { if (ev === 'change') listeners.push(l); },
            removeEventListener
        }));

        let hydrated = false;
        const name = uniqueName('MediaDefer');
        registerComponent(name, component(() => { hydrated = true; return () => <span>m</span>; }, { name }));

        container = createSSRContainer('<span>m</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'media', media: '(max-width: 600px)', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        expect(hydrated).toBe(false);

        listeners.forEach(l => l({ matches: true }));
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();
        expect(hydrated).toBe(true);
        expect(removeEventListener).toHaveBeenCalled();

        delete (globalThis as any).matchMedia;
    });

    // ─── visible strategy ────────────────────────────────────────────

    it('defers a visible island until intersection, then disconnects the observer', async () => {
        let observerCb: ((entries: any[]) => void) | null = null;
        const observed: Element[] = [];
        let disconnected = false;
        (globalThis as any).IntersectionObserver = function (this: any, cb: any) {
            observerCb = cb;
            this.observe = (el: Element) => observed.push(el);
            this.disconnect = () => { disconnected = true; };
            this.unobserve = vi.fn();
        };

        let hydrated = false;
        const name = uniqueName('Visible');
        registerComponent(name, component(() => { hydrated = true; return () => <span>v</span>; }, { name }));

        container = createSSRContainer('<span class="vis">v</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'visible', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrated).toBe(false);
        expect(observed.length).toBeGreaterThan(0);

        observerCb!([{ isIntersecting: true, target: observed[0] }]);
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();
        expect(hydrated).toBe(true);
        expect(disconnected).toBe(true);

        delete (globalThis as any).IntersectionObserver;
    });

    it('invokes the visible callback immediately when there is no element before the marker (no observer)', async () => {
        let observerConstructed = false;
        (globalThis as any).IntersectionObserver = function (this: any) {
            observerConstructed = true;
            this.observe = vi.fn(); this.disconnect = vi.fn(); this.unobserve = vi.fn();
        };

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const name = uniqueName('VisibleNoEl');
        registerComponent(name, component(() => () => <span>v</span>, { name }));

        // Marker is the first child — no element precedes it → observeVisibility
        // calls the callback immediately without constructing an observer. The
        // subsequent hydrateIsland then finds no element to hydrate and warns.
        container = createSSRContainer('<!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'visible', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        expect(observerConstructed).toBe(false);
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('No element found for island hydration');

        delete (globalThis as any).IntersectionObserver;
    });

    it('cleanupPendingHydrations disconnects a pending visible observer', async () => {
        let disconnected = false;
        (globalThis as any).IntersectionObserver = function (this: any) {
            this.observe = vi.fn();
            this.disconnect = () => { disconnected = true; };
            this.unobserve = vi.fn();
        };

        const name = uniqueName('VisibleCleanup');
        registerComponent(name, component(() => () => <span>v</span>, { name }));

        container = createSSRContainer('<span class="vis">v</span><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'visible', componentId: name, props: {} } });

        hydrateIslands();
        cleanupPendingHydrations();
        expect(disconnected).toBe(true);

        delete (globalThis as any).IntersectionObserver;
    });

    // ─── hydrateIsland / mountClientOnly element resolution ──────────

    it('warns when a load island has no element before its marker to hydrate', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const name = uniqueName('NoElement');
        registerComponent(name, component(() => () => <span>x</span>, { name }));

        // Marker with no preceding element node.
        container = createSSRContainer('<!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'load', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('No element found for island hydration');
    });

    it('mounts a client:only island into a data-island placeholder (clearing SSR content)', async () => {
        let mounted = false;
        const name = uniqueName('OnlyPlaceholder');
        registerComponent(name, component(() => {
            mounted = true;
            return () => <span class="co">only</span>;
        }, { name }));

        // A real skip-SSR placeholder: <div data-island> with stale content.
        container = createSSRContainer('<div data-island="1">stale</div><!--$c:1-->');
        createIslandDataScript({ '1': { strategy: 'only', componentId: name, props: {} } });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        expect(mounted).toBe(true);
        // Placeholder was cleared and re-rendered.
        expect(container.querySelector('.co')?.textContent).toBe('only');
        expect(container.textContent).not.toContain('stale');
    });
});

describe('seedPendingServerState', () => {
    it('is a no-op when no host restoration sink is wired (does not throw)', () => {
        expect(() => seedPendingServerState({ a: 1 })).not.toThrow();
        expect(() => seedPendingServerState(null)).not.toThrow();
        expect(() => seedPendingServerState(undefined)).not.toThrow();
    });
});
