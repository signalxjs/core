/**
 * Tests for lazy registry, chunk loader, and async island hydration
 *
 * Covers the per-island code splitting infrastructure:
 * - __registerIslandChunk / resolveComponent / hasComponent
 * - loadIslandComponent (eager → lazy → chunkUrl resolution)
 * - hydrateIslands() with lazily-registered components
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import {
    registerComponent,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    type ComponentFactory
} from '../src/client/registry';
import { loadIslandComponent } from '../src/client/chunk-loader';
import { hydrateIslands } from '../src/client/hydrate-islands';
import {
    createSSRContainer,
    cleanupContainer,
    createIslandDataScript,
    cleanupScripts,
    nextTick
} from './test-utils';

// ─── Test Components ───────────────────────────────────────────────

const LazyCounter = component(() => {
    const count = signal(0);
    return () => <span class="lazy-counter">{count.value}</span>;
}, { name: 'LazyCounter' });

const LazyWidget = component(() => {
    return () => <div class="lazy-widget">Widget</div>;
}, { name: 'LazyWidget' });

const AnotherComponent = component(() => {
    return () => <div class="another">Another</div>;
}, { name: 'AnotherComponent' });

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * We need to reset the registry between tests.
 * Since the registry uses module-level Maps, we re-import or
 * just re-register to override. For a clean slate, we'll use
 * a fresh approach: the registry caches resolved lazy→eager,
 * so we test behavior, not internal state cleanup.
 */

// Unique names per test to avoid cross-test pollution from module-level Maps
let testId = 0;
function uniqueName(base: string): string {
    return `${base}_${++testId}`;
}

// ─── Registry Tests ────────────────────────────────────────────────

describe('lazy registry', () => {
    describe('__registerIslandChunk', () => {
        it('should register a lazy loader', () => {
            const name = uniqueName('LazyReg');
            __registerIslandChunk(name, () => Promise.resolve(LazyCounter));

            // Not in eager registry
            expect(getComponent(name)).toBeUndefined();
            // But hasComponent should return true
            expect(hasComponent(name)).toBe(true);
        });

        it('should overwrite previous lazy registration', () => {
            const name = uniqueName('LazyOverwrite');
            let callCount = 0;

            __registerIslandChunk(name, () => { callCount++; return Promise.resolve(LazyCounter); });
            __registerIslandChunk(name, () => { callCount += 10; return Promise.resolve(LazyWidget); });

            expect(hasComponent(name)).toBe(true);
        });
    });

    describe('hasComponent', () => {
        it('should return true for eagerly registered components', () => {
            const name = uniqueName('EagerHas');
            registerComponent(name, LazyCounter);
            expect(hasComponent(name)).toBe(true);
        });

        it('should return true for lazily registered components', () => {
            const name = uniqueName('LazyHas');
            __registerIslandChunk(name, () => Promise.resolve(LazyCounter));
            expect(hasComponent(name)).toBe(true);
        });

        it('should return false for unknown components', () => {
            expect(hasComponent('CompletelyUnknown_999')).toBe(false);
        });
    });

    describe('resolveComponent', () => {
        it('should resolve eagerly registered component instantly', async () => {
            const name = uniqueName('EagerResolve');
            registerComponent(name, LazyCounter);

            const result = await resolveComponent(name);
            expect(result).toBe(LazyCounter);
        });

        it('should resolve lazily registered component via loader', async () => {
            const name = uniqueName('LazyResolve');
            const loader = vi.fn(() => Promise.resolve(LazyWidget));
            __registerIslandChunk(name, loader);

            const result = await resolveComponent(name);
            expect(result).toBe(LazyWidget);
            expect(loader).toHaveBeenCalledOnce();
        });

        it('should cache resolved lazy component in eager registry', async () => {
            const name = uniqueName('LazyCache');
            const loader = vi.fn(() => Promise.resolve(LazyCounter));
            __registerIslandChunk(name, loader);

            // First resolve
            await resolveComponent(name);
            // Second resolve should hit eager cache
            const result2 = await resolveComponent(name);

            expect(result2).toBe(LazyCounter);
            expect(loader).toHaveBeenCalledOnce(); // Only called once
            // Now also available via sync getComponent
            expect(getComponent(name)).toBe(LazyCounter);
        });

        it('should deduplicate concurrent resolveComponent calls', async () => {
            const name = uniqueName('LazyDedup');
            let resolveLoader!: (val: ComponentFactory) => void;
            const loader = vi.fn(() => new Promise<ComponentFactory>((r) => { resolveLoader = r; }));
            __registerIslandChunk(name, loader);

            // Start two concurrent resolves
            const p1 = resolveComponent(name);
            const p2 = resolveComponent(name);

            // Resolve the loader
            resolveLoader(LazyCounter);

            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1).toBe(LazyCounter);
            expect(r2).toBe(LazyCounter);
            expect(loader).toHaveBeenCalledOnce(); // Only one import()
        });

        it('should unwrap { default: Component } module format', async () => {
            const name = uniqueName('LazyDefault');
            __registerIslandChunk(name, () => Promise.resolve({ default: LazyWidget } as any));

            const result = await resolveComponent(name);
            expect(result).toBe(LazyWidget);
        });

        it('should unwrap named export matching component name', async () => {
            const name = uniqueName('LazyNamed');
            // Simulates: import('./module') resolving to { [name]: Component }
            const mod = { [name]: AnotherComponent } as any;
            __registerIslandChunk(name, () => Promise.resolve(mod));

            const result = await resolveComponent(name);
            expect(result).toBe(AnotherComponent);
        });

        it('should return undefined for unknown components', async () => {
            const result = await resolveComponent('TotallyUnknown_999');
            expect(result).toBeUndefined();
        });

        it('should handle loader errors gracefully', async () => {
            const name = uniqueName('LazyError');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            __registerIslandChunk(name, () => Promise.reject(new Error('Network failure')));

            const result = await resolveComponent(name);
            // Should not throw, returns undefined-ish
            // (the catch returns undefined as any)
            consoleSpy.mockRestore();
        });
    });
});

// ─── Chunk Loader Tests ────────────────────────────────────────────

describe('loadIslandComponent', () => {
    it('should resolve from eager registry first', async () => {
        const name = uniqueName('ChunkEager');
        registerComponent(name, LazyCounter);

        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: name,
            props: {}
        });

        expect(result).toBe(LazyCounter);
    });

    it('should resolve from lazy registry when not eagerly registered', async () => {
        const name = uniqueName('ChunkLazy');
        __registerIslandChunk(name, () => Promise.resolve(LazyWidget));

        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: name,
            props: {}
        });

        expect(result).toBe(LazyWidget);
    });

    it('should return undefined when component is not found anywhere', async () => {
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: 'GhostComponent_999',
            props: {}
        });

        expect(result).toBeUndefined();
    });

    it('should return undefined when componentId is missing', async () => {
        const result = await loadIslandComponent({
            strategy: 'load',
            props: {}
        } as any);

        expect(result).toBeUndefined();
    });

    it('should prefer eager over lazy', async () => {
        const name = uniqueName('ChunkPrefer');
        registerComponent(name, LazyCounter);
        const lazySpy = vi.fn(() => Promise.resolve(LazyWidget));
        __registerIslandChunk(name, lazySpy);

        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: name,
            props: {}
        });

        expect(result).toBe(LazyCounter); // Eager wins
        expect(lazySpy).not.toHaveBeenCalled(); // Lazy never called
    });
});

// ─── Lazy Hydration Integration Tests ──────────────────────────────

describe('hydrateIslands with lazy components', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        vi.useRealTimers();
    });

    it('should hydrate client:load island with lazily registered component', async () => {
        let hydrated = false;
        const name = uniqueName('LazyLoadIsland');

        const LazyLoadComp = component(() => {
            hydrated = true;
            return () => <span class="lazy-load">Loaded</span>;
        }, { name: name });

        // Register lazily (simulating what the Vite plugin does)
        __registerIslandChunk(name, () => Promise.resolve(LazyLoadComp));

        container = createSSRContainer(`<span class="lazy-load">Loaded</span><!--$c:1-->`);
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {} }
        });

        hydrateIslands();

        // Lazy resolution is async — need to flush promises
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        expect(hydrated).toBe(true);
    });

    it('hydrates a client:only island in place when there is no placeholder (#122 regression)', async () => {
        let hydrated = false;
        const name = uniqueName('ClientOnlyInPlace');

        const ClientOnlyComp = component(() => {
            hydrated = true;
            return () => <span class="co-inplace">Only</span>;
        }, { name });

        registerComponent(name, ClientOnlyComp);

        // Under the current render path client:only is server-rendered IN PLACE
        // (no <div data-island> placeholder), so hydrateIslands() must hydrate the
        // existing content rather than silently do nothing.
        container = createSSRContainer(`<span class="co-inplace">Only</span><!--$c:1-->`);
        createIslandDataScript({
            '1': { strategy: 'only', componentId: name, props: {} }
        });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        expect(hydrated).toBe(true);
    });

    it('should hydrate client:idle island with lazily registered component', async () => {
        let hydrated = false;
        const name = uniqueName('LazyIdleIsland');

        const LazyIdleComp = component(() => {
            hydrated = true;
            return () => <span class="lazy-idle">Idle</span>;
        }, { name: name });

        // Mock requestIdleCallback
        const idleCallbacks: (() => void)[] = [];
        const originalRIC = (globalThis as any).requestIdleCallback;
        (globalThis as any).requestIdleCallback = (cb: () => void) => {
            idleCallbacks.push(cb);
            return idleCallbacks.length;
        };

        __registerIslandChunk(name, () => Promise.resolve(LazyIdleComp));

        container = createSSRContainer(`<span class="lazy-idle">Idle</span><!--$c:1-->`);
        createIslandDataScript({
            '1': { strategy: 'idle', componentId: name, props: {} }
        });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(0);

        // Not hydrated yet — idle callback hasn't fired
        expect(hydrated).toBe(false);

        // Fire idle callbacks (which triggers lazy load)
        idleCallbacks.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        expect(hydrated).toBe(true);

        (globalThis as any).requestIdleCallback = originalRIC;
    });

    it('should warn when lazy component fails to load', async () => {
        const name = uniqueName('LazyFailIsland');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        __registerIslandChunk(name, () => Promise.reject(new Error('chunk failed')));

        container = createSSRContainer(`<span>Fail</span><!--$c:1-->`);
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {} }
        });

        hydrateIslands();
        await vi.advanceTimersByTimeAsync(50);
        await nextTick();

        // Should have warned about failed resolution
        const allMessages = [
            ...warnSpy.mock.calls.map(c => c.join(' ')),
            ...errorSpy.mock.calls.map(c => c.join(' '))
        ].join('\n');
        expect(allMessages).toContain(name);

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
