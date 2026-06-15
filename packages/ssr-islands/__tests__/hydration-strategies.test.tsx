/**
 * Tests for selective hydration strategies
 * Tests client:load, client:idle, client:visible, client:media, client:only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../../server-renderer/src/client/hydrate-core';
import { hydrateIslands } from '../src/client/hydrate-islands';
import { registerComponent } from '../src/client/registry';
import { registerClientPlugin, clearClientPlugins } from '../../server-renderer/src/client/hydrate-context';
import { islandsPlugin } from '../src/plugin';
import {
    createSSRContainer,
    cleanupContainer,
    createIslandDataScript,
    cleanupScripts,
    ssrComponentMarkers,
    nextTick,
    waitForIdle
} from './test-utils';

describe('hydration strategies', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        clearClientPlugins();
        registerClientPlugin(islandsPlugin());
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        clearClientPlugins();
        vi.useRealTimers();
    });

    describe('client:load', () => {
        it('should hydrate immediately when client:load is set', async () => {
            const LoadComponent = component(() => {
                const loaded = signal(true);
                return () => <span class="loaded">{loaded.value ? 'yes' : 'no'}</span>;
            }, { name: 'LoadComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="loaded">yes</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: LoadComponent,
                props: { 'client:load': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            
            // Should hydrate immediately (synchronously)
            await nextTick();

            expect(container.querySelector('.loaded')?.textContent).toBe('yes');
        });
    });

    describe('client:idle', () => {
        it('should schedule hydration with requestIdleCallback', async () => {
            const IdleComponent = component(() => {
                const hydrated = signal(true);
                return () => <span class="hydrated">{hydrated.value ? 'yes' : 'no'}</span>;
            }, { name: 'IdleComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="hydrated">yes</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: IdleComponent,
                props: { 'client:idle': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);

            // Advance timers to trigger idle callback fallback (setTimeout 200ms)
            await vi.advanceTimersByTimeAsync(250);

            expect(container.querySelector('.hydrated')?.textContent).toBe('yes');
        });

        it('should use setTimeout fallback when requestIdleCallback is not available', async () => {
            // Mock environment without requestIdleCallback
            const originalRIC = (globalThis as any).requestIdleCallback;
            delete (globalThis as any).requestIdleCallback;

            const FallbackComponent = component(() => {
                const value = signal('idle');
                return () => <span class="value">{value.value}</span>;
            }, { name: 'FallbackComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="value">idle</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: FallbackComponent,
                props: { 'client:idle': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);

            // Should use 200ms setTimeout fallback
            await vi.advanceTimersByTimeAsync(250);

            expect(container.querySelector('.value')?.textContent).toBe('idle');

            // Restore
            (globalThis as any).requestIdleCallback = originalRIC;
        });
    });

    describe('client:visible', () => {
        let observerCallback: ((entries: { isIntersecting: boolean; target: Element }[]) => void) | null = null;
        let observedElements: Element[] = [];
        let disconnected = false;
        let observerOptions: any = null;

        beforeEach(() => {
            observerCallback = null;
            observedElements = [];
            disconnected = false;
            observerOptions = null;

            // Mock IntersectionObserver - must be a real function (not arrow) to support `new`
            (globalThis as any).IntersectionObserver = function(this: any, callback: any, options?: any) {
                observerCallback = callback;
                observerOptions = options;
                this.observe = (el: Element) => { observedElements.push(el); };
                this.disconnect = () => { disconnected = true; };
                this.unobserve = vi.fn();
            };
        });

        afterEach(() => {
            delete (globalThis as any).IntersectionObserver;
        });

        it('should defer hydration until element is visible', async () => {
            let hydrated = false;

            const VisibleComponent = component(() => {
                hydrated = true;
                return () => <span class="visible">Visible</span>;
            }, { name: 'VisibleComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="visible">Visible</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: VisibleComponent,
                props: { 'client:visible': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            // Should NOT be hydrated yet (waiting for intersection)
            expect(hydrated).toBe(false);
            expect(observedElements.length).toBeGreaterThan(0);
        });

        it('should hydrate when intersection fires with isIntersecting: true', async () => {
            let hydrated = false;

            const VisibleComponent2 = component(() => {
                hydrated = true;
                return () => <span class="vis2">Content</span>;
            }, { name: 'VisibleComponent2' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="vis2">Content</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: VisibleComponent2,
                props: { 'client:visible': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);
            expect(hydrated).toBe(false);

            // Simulate intersection
            if (observerCallback && observedElements[0]) {
                observerCallback([{ isIntersecting: true, target: observedElements[0] }]);
            }
            await vi.advanceTimersByTimeAsync(0);

            expect(hydrated).toBe(true);
        });

        it('should disconnect observer after hydration', async () => {
            const VisibleComponent3 = component(() => {
                return () => <span>Observed</span>;
            }, { name: 'VisibleComponent3' });

            const ssrHtml = ssrComponentMarkers(1, '<span>Observed</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: VisibleComponent3,
                props: { 'client:visible': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            expect(disconnected).toBe(false);

            // Trigger intersection
            if (observerCallback && observedElements[0]) {
                observerCallback([{ isIntersecting: true, target: observedElements[0] }]);
            }
            await vi.advanceTimersByTimeAsync(0);

            expect(disconnected).toBe(true);
        });

        it('should not hydrate when isIntersecting is false', async () => {
            let hydrated = false;

            const VisibleComponent4 = component(() => {
                hydrated = true;
                return () => <span>Not yet</span>;
            }, { name: 'VisibleComponent4' });

            const ssrHtml = ssrComponentMarkers(1, '<span>Not yet</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: VisibleComponent4,
                props: { 'client:visible': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            // Fire with isIntersecting: false
            if (observerCallback && observedElements[0]) {
                observerCallback([{ isIntersecting: false, target: observedElements[0] }]);
            }
            await vi.advanceTimersByTimeAsync(0);

            expect(hydrated).toBe(false);
            expect(disconnected).toBe(false);
        });

        it('should use 50px rootMargin', async () => {
            const VisibleComponent5 = component(() => {
                return () => <span>RootMargin</span>;
            }, { name: 'VisibleComponent5' });

            const ssrHtml = ssrComponentMarkers(1, '<span>RootMargin</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: VisibleComponent5,
                props: { 'client:visible': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            expect(observerOptions).toBeDefined();
            expect(observerOptions.rootMargin).toBe('50px');
        });
    });

    describe('client:media', () => {
        let mediaQueryMatches = false;
        let changeListeners: ((e: MediaQueryListEvent) => void)[] = [];

        beforeEach(() => {
            mediaQueryMatches = false;
            changeListeners = [];

            // Mock matchMedia
            (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
                matches: mediaQueryMatches,
                media: query,
                addEventListener: (event: string, listener: (e: MediaQueryListEvent) => void) => {
                    if (event === 'change') {
                        changeListeners.push(listener);
                    }
                },
                removeEventListener: vi.fn()
            }));
        });

        afterEach(() => {
            delete (globalThis as any).matchMedia;
        });

        it('should hydrate immediately when media query matches', async () => {
            mediaQueryMatches = true;

            const MediaComponent = component(() => {
                return () => <span class="media">Mobile</span>;
            }, { name: 'MediaComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="media">Mobile</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: MediaComponent,
                props: { 'client:media': '(max-width: 768px)' },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            expect(container.querySelector('.media')?.textContent).toBe('Mobile');
        });

        it('should wait for media query to match before hydrating', async () => {
            mediaQueryMatches = false;
            let hydrated = false;

            const WaitingComponent = component(() => {
                hydrated = true;
                return () => <span>Waiting</span>;
            }, { name: 'WaitingComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>Waiting</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: WaitingComponent,
                props: { 'client:media': '(max-width: 768px)' },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(100);

            // Should not be hydrated yet
            expect(hydrated).toBe(false);

            // Simulate media query change
            for (const listener of changeListeners) {
                listener({ matches: true } as MediaQueryListEvent);
            }

            await vi.advanceTimersByTimeAsync(0);

            expect(hydrated).toBe(true);
        });
    });

    describe('client:only', () => {
        it('should mount fresh component without SSR content', async () => {
            let setupCalled = false;

            const ClientOnlyComponent = component(() => {
                setupCalled = true;
                return () => <span class="client-only">Client Only</span>;
            }, { name: 'ClientOnlyComponent' });

            // client:only renders an empty placeholder on server
            const ssrHtml = `<div data-island="1" style="display:contents;"></div><!--$c:1-->`;
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: ClientOnlyComponent,
                props: { 'client:only': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            expect(setupCalled).toBe(true);
        });

        it('should render component content fresh into the data-island placeholder', async () => {
            const ClientOnlyContent = component(() => {
                return () => <div class="co-content">Fresh mount</div>;
            }, { name: 'ClientOnlyContent' });

            const ssrHtml = `<div data-island="1" style="display:contents;"></div><!--$c:1-->`;
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: ClientOnlyContent,
                props: { 'client:only': true },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await vi.advanceTimersByTimeAsync(0);

            // Fresh-mounted content lives INSIDE the data-island placeholder.
            const placeholder = container.querySelector('[data-island]');
            expect(placeholder).toBeTruthy();
            const content = placeholder!.querySelector('.co-content');
            expect(content).toBeTruthy();
            expect(content!.textContent).toBe('Fresh mount');
        });
    });

    describe('hydrateIslands()', () => {
        it('should discover and hydrate islands from __SIGX_ISLANDS__ data', async () => {
            let hydrated = false;

            const IslandComp = component(() => {
                hydrated = true;
                return () => <span class="island">Island</span>;
            }, { name: 'IslandComp' });

            // Register the component
            registerComponent('IslandComp', IslandComp);

            // Set up SSR DOM with trailing markers
            container = createSSRContainer('<span class="island">Island</span><!--$c:1-->');

            // Set up island data
            createIslandDataScript({
                '1': {
                    strategy: 'load',
                    componentId: 'IslandComp',
                    props: {}
                }
            });

            hydrateIslands();
            await vi.advanceTimersByTimeAsync(0);

            expect(hydrated).toBe(true);
        });

        it('should handle missing __SIGX_ISLANDS__ script gracefully', () => {
            // No script tag, should not throw
            expect(() => hydrateIslands()).not.toThrow();
        });

        it('should warn for unregistered components', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            container = createSSRContainer('<span>Unknown</span><!--$c:1-->');
            createIslandDataScript({
                '1': {
                    strategy: 'load',
                    componentId: 'NonExistentComponent',
                    props: {}
                }
            });

            hydrateIslands();
            await vi.advanceTimersByTimeAsync(0);

            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('should respect different strategies per island', async () => {
            // Mock requestIdleCallback so the 'idle' strategy path works in happy-dom
            const originalRIC = (globalThis as any).requestIdleCallback;
            const idleCallbacks: (() => void)[] = [];
            (globalThis as any).requestIdleCallback = (cb: () => void) => { idleCallbacks.push(cb); };

            let loadHydrated = false;
            let idleHydrated = false;

            const LoadIsland = component(() => {
                loadHydrated = true;
                return () => <span>Load</span>;
            }, { name: 'LoadIsland' });

            const IdleIsland = component(() => {
                idleHydrated = true;
                return () => <span>Idle</span>;
            }, { name: 'IdleIsland' });

            registerComponent('LoadIsland', LoadIsland);
            registerComponent('IdleIsland', IdleIsland);

            container = createSSRContainer(
                '<span>Load</span><!--$c:1--><span>Idle</span><!--$c:2-->'
            );

            createIslandDataScript({
                '1': { strategy: 'load', componentId: 'LoadIsland' },
                '2': { strategy: 'idle', componentId: 'IdleIsland' }
            });

            hydrateIslands();

            // client:load should hydrate immediately
            await vi.advanceTimersByTimeAsync(0);
            expect(loadHydrated).toBe(true);

            // client:idle should be queued via requestIdleCallback
            expect(idleHydrated).toBe(false);
            // Fire the idle callbacks
            idleCallbacks.forEach(cb => cb());
            await vi.advanceTimersByTimeAsync(0);
            expect(idleHydrated).toBe(true);

            // Restore
            (globalThis as any).requestIdleCallback = originalRIC;
        });
    });
});

describe('strategy priority', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        clearClientPlugins();
        registerClientPlugin(islandsPlugin());
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        clearClientPlugins();
    });

    it('should only apply first matching strategy when multiple are set', async () => {
        // When both client:load and client:idle are set, client:load should take priority
        const MultiStrategyComponent = component(() => {
            return () => <span>Multi</span>;
        }, { name: 'MultiStrategyComponent' });

        const ssrHtml = ssrComponentMarkers(1, '<span>Multi</span>');
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: MultiStrategyComponent,
            props: { 'client:load': true, 'client:idle': true },
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await new Promise(r => setTimeout(r, 0));

        // Should hydrate immediately due to client:load
        expect(container.querySelector('span')?.textContent).toBe('Multi');
    });
});
